import type { SupabaseClient } from "@supabase/supabase-js";
import type { SpendFact, Vendor } from "@/lib/types";
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
  source: Vendor,
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
  source: Vendor,
  syncRunId: string,
  payload: unknown,
) {
  await supabase
    .from("raw_payloads")
    .insert({ source, sync_run_id: syncRunId, payload });
}
