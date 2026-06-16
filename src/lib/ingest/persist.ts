import type { SupabaseClient } from "@supabase/supabase-js";
import type { SpendFact } from "@/lib/types";
import { matchIdentity } from "@/lib/ingest/identity";

export interface ResolvedFact extends SpendFact {
  employeeId: string | null;
}

/**
 * Attach employee_id to facts by resolving entity_key (an email) through the
 * employee list. Pure — no I/O. Unmatched facts keep employeeId null and their
 * entity_key is collected for the "Unmatched" queue (never dropped, spec §5).
 */
export function attachEmployees(
  facts: SpendFact[],
  employees: { id: string; email: string }[],
): { facts: ResolvedFact[]; unmatched: string[] } {
  const unmatched = new Set<string>();
  const resolved = facts.map((f) => {
    const { employeeId } = matchIdentity(f.entityKey, employees);
    if (!employeeId) unmatched.add(f.entityKey);
    return { ...f, employeeId };
  });
  return { facts: resolved, unmatched: [...unmatched] };
}

export async function loadEmployees(supabase: SupabaseClient) {
  const { data, error } = await supabase.from("employees").select("id, email");
  if (error) throw new Error(`loadEmployees: ${error.message}`);
  return data ?? [];
}

/** Attach employee_id to API-platform facts via the key/project owner map. */
export function attachOwners(
  facts: SpendFact[],
  ownerByEntity: Map<string, string | null>,
): { facts: ResolvedFact[]; unmatched: string[] } {
  const unmatched = new Set<string>();
  const resolved = facts.map((f) => {
    const employeeId = ownerByEntity.get(f.entityKey) ?? null;
    if (!employeeId) unmatched.add(f.entityKey);
    return { ...f, employeeId };
  });
  return { facts: resolved, unmatched: [...unmatched] };
}

/** external id → owner employee (override wins over creator, spec §5 rule 3). */
export async function loadApiKeyOwners(supabase: SupabaseClient): Promise<Map<string, string | null>> {
  const { data } = await supabase.from("api_keys").select("external_key_id, owner_employee_id, owner_override");
  return new Map((data ?? []).map((k) => [k.external_key_id as string, (k.owner_override ?? k.owner_employee_id) as string | null]));
}

export async function loadProjectOwners(supabase: SupabaseClient): Promise<Map<string, string | null>> {
  const { data } = await supabase.from("projects").select("external_id, owner_employee_id, owner_override");
  return new Map((data ?? []).map((p) => [p.external_id as string, (p.owner_override ?? p.owner_employee_id) as string | null]));
}

/** Employees with names, for ChatGPT's no-email fuzzy matching. */
export async function loadEmployeeNames(supabase: SupabaseClient) {
  const { data, error } = await supabase.from("employees").select("id, fullName:full_name");
  if (error) throw new Error(`loadEmployeeNames: ${error.message}`);
  return (data ?? []) as { id: string; fullName: string }[];
}

/** Upsert employees from HiBob (the identity spine). Keyed on email. */
export async function upsertEmployees(
  supabase: SupabaseClient,
  rows: Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await supabase.from("employees").upsert(rows, { onConflict: "email" });
  if (error) throw new Error(`upsertEmployees: ${error.message}`);
  return rows.length;
}

/** Idempotent upsert on the (source, day, cost_type, entity_key, model) key. */
export async function upsertSpendFacts(
  supabase: SupabaseClient,
  facts: ResolvedFact[],
): Promise<number> {
  if (facts.length === 0) return 0;
  const rows = facts.map((f) => ({
    source: f.source,
    day: f.day,
    cost_type: f.costType,
    entity_key: f.entityKey,
    cost_usd: f.costUsd,
    tokens: f.tokens ?? null,
    requests: f.requests ?? null,
    employee_id: f.employeeId,
    model: f.model ?? "",
  }));
  const { error } = await supabase
    .from("spend_facts")
    .upsert(rows, { onConflict: "source,day,cost_type,entity_key,model" });
  if (error) throw new Error(`upsertSpendFacts: ${error.message}`);
  return rows.length;
}

export async function startSyncRun(
  supabase: SupabaseClient,
  source: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("sync_runs")
    .insert({ source, status: "running" })
    .select("id")
    .single();
  if (error) throw new Error(`startSyncRun: ${error.message}`);
  return data.id as string;
}

export async function finishSyncRun(
  supabase: SupabaseClient,
  id: string,
  result: { status: "success" | "failed"; rowsWritten?: number; error?: string },
) {
  await supabase
    .from("sync_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: result.status,
      rows_written: result.rowsWritten ?? 0,
      error_detail: result.error ?? null,
    })
    .eq("id", id);
}

export async function saveRawPayload(
  supabase: SupabaseClient,
  source: string,
  syncRunId: string,
  payload: unknown,
) {
  await supabase
    .from("raw_payloads")
    .insert({ source, sync_run_id: syncRunId, payload });
}
