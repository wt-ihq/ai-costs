"use server";

import { revalidatePath, updateTag } from "next/cache";
import { FACTS_TAG } from "@/lib/queries/cached";
import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Vendor } from "@/lib/types";

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
  const supabase = getSupabaseAdminClient();

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

  updateTag(FACTS_TAG);
  revalidatePath("/data-health");
  return { updated: data?.length ?? 0 };
}
