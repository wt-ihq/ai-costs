"use server";

import { revalidatePath, updateTag } from "next/cache";
import { FACTS_TAG } from "@/lib/queries/cached";
import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { isPseudoEntity } from "@/lib/pseudo-entities";
import { buildFormerUserRow, ownerOverrideTarget } from "@/lib/former-users";

/**
 * Shared assignment step: backfill employee_id on the unmatched facts for
 * (source, entityKey), record the identity so future imports match, and — for
 * Anthropic keys / OpenAI projects — set the durable owner override so the next
 * re-sync (which rebuilds facts from the key's creator) keeps the assignment.
 */
async function applyAssignment(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  source: Vendor,
  entityKey: string,
  employeeId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("spend_facts")
    .update({ employee_id: employeeId })
    .eq("source", source)
    .eq("entity_key", entityKey)
    .is("employee_id", null)
    .select("id");
  if (error) throw new Error(`assignUnmatched: ${error.message}`);

  const isEmail = entityKey.includes("@");
  await supabase.from("identities").upsert(
    {
      vendor: source,
      employee_id: employeeId,
      match_method: "manual",
      external_email: isEmail ? entityKey : null,
      external_id: isEmail ? null : entityKey,
    },
    { onConflict: isEmail ? "vendor,external_email" : "vendor,external_id" },
  );

  const target = ownerOverrideTarget(source, entityKey);
  if (target) {
    // Upsert (vendor-scoped): the key/project row may not exist yet.
    const { error: ovErr } = await supabase
      .from(target.table)
      .upsert({ vendor: source, [target.column]: entityKey, owner_override: employeeId }, { onConflict: target.conflict });
    if (ovErr) throw new Error(`assignUnmatched owner override: ${ovErr.message}`);
  }
  return data?.length ?? 0;
}

/**
 * Assign an unmatched entity (an email, name, or key/project id) to an
 * employee: backfill employee_id on its facts and record the identity so future
 * imports match automatically (spec §7.5 one-click assign).
 */
export async function assignUnmatched(
  source: Vendor,
  entityKey: string,
  employeeId: string,
): Promise<{ updated: number }> {
  await requireAdmin();
  if (!Object.hasOwn(VENDOR_LABEL, source)) throw new Error("Unknown source");
  if (!entityKey?.trim() || isPseudoEntity(entityKey)) throw new Error("This entity can't be assigned to a person");
  const supabase = getSupabaseAdminClient();
  try {
    const updated = await applyAssignment(supabase, source, entityKey, employeeId);
    return { updated };
  } finally {
    // Bust even when a later step threw: the facts update may already have landed.
    updateTag(FACTS_TAG);
    revalidatePath("/data");
  }
}

/**
 * Mark an unmatched key as a former user: create a leaver employee (name,
 * email, old team, optional leaving month) and assign the key's spend to them.
 * Also clears any other unmatched facts keyed by the new email.
 */
export async function addFormerUser(input: {
  source: Vendor;
  entityKey: string;
  name: string;
  email: string;
  team: string;
  left: string;
}): Promise<{ ok: true; assignedRows: number } | { ok: false; error: string }> {
  await requireAdmin();
  if (!Object.hasOwn(VENDOR_LABEL, input.source)) return { ok: false, error: "Unknown source" };
  if (!input.entityKey?.trim()) return { ok: false, error: "Missing entity key" };
  if (isPseudoEntity(input.entityKey)) return { ok: false, error: "This entity can't be assigned to a person" };
  let wrote = false;
  try {

    const supabase = getSupabaseAdminClient();
    const emps = await fetchEmployeesAll(supabase, "email, department");
    const emails = emps.map((e) => e.email as string);
    const departments = [...new Set(emps.map((e) => e.department as string | null).filter((d): d is string => !!d))];

    const built = buildFormerUserRow(
      { name: input.name, email: input.email, team: input.team, left: input.left },
      departments,
      emails,
    );
    if (!built.ok) return built;

    const { data: created, error } = await supabase.from("employees").insert(built.row).select("id").single();
    if (error || !created) return { ok: false, error: `Could not create the person: ${error?.message ?? "no row"}` };
    wrote = true;
    const employeeId = created.id as string;

    let assignedRows = await applyAssignment(supabase, input.source, input.entityKey, employeeId);

    // Same person's other email-keyed unmatched rows (any source).
    const { data: rest, error: restErr } = await supabase
      .from("spend_facts")
      .update({ employee_id: employeeId })
      .eq("entity_key", built.row.email)
      .is("employee_id", null)
      .select("id");
    if (restErr) throw new Error(`addFormerUser: ${restErr.message}`);
    assignedRows += rest?.length ?? 0;

    return { ok: true, assignedRows };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Once the person exists the page is stale even if a later step failed.
    if (wrote) {
      updateTag(FACTS_TAG);
      revalidatePath("/data");
    }
  }
}
