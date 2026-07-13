import type { SupabaseClient } from "@supabase/supabase-js";
import type { SpendFact, ModelUsageFact, CostType } from "@/lib/types";
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

/**
 * Read every row of a table, paging past PostgREST's 1000-row cap (gotcha #1 —
 * employees only ever grows because Okta leavers are retained, so a bare
 * .select() would silently truncate attribution past 1000 rows). Ordered by the
 * unique id so pages can't overlap or skip.
 */
async function selectAllRows<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  label: string,
): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    all.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

export async function loadEmployees(supabase: SupabaseClient) {
  return selectAllRows<{ id: string; email: string }>(supabase, "employees", "id, email", "loadEmployees");
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

/**
 * external id → owner employee (override wins over creator, spec §5 rule 3).
 * Throws on read errors: a swallowed error here would write a whole window
 * unattributed and report success.
 */
export async function loadApiKeyOwners(supabase: SupabaseClient): Promise<Map<string, string | null>> {
  const rows = await selectAllRows<{ external_key_id: string; owner_employee_id: string | null; owner_override: string | null }>(
    supabase, "api_keys", "id, external_key_id, owner_employee_id, owner_override", "loadApiKeyOwners",
  );
  return new Map(rows.map((k) => [k.external_key_id, k.owner_override ?? k.owner_employee_id]));
}

export async function loadProjectOwners(supabase: SupabaseClient): Promise<Map<string, string | null>> {
  const rows = await selectAllRows<{ external_id: string; owner_employee_id: string | null; owner_override: string | null }>(
    supabase, "projects", "id, external_id, owner_employee_id, owner_override", "loadProjectOwners",
  );
  return new Map(rows.map((p) => [p.external_id, p.owner_override ?? p.owner_employee_id]));
}

/** Employees with names, for ChatGPT's no-email fuzzy matching. */
export async function loadEmployeeNames(supabase: SupabaseClient) {
  return selectAllRows<{ id: string; fullName: string }>(supabase, "employees", "id, fullName:full_name", "loadEmployeeNames");
}

/** Employees with email + name, paginated (gotcha #1) — for email-keyed import previews. */
export async function loadEmployeesFull(supabase: SupabaseClient) {
  return selectAllRows<{ id: string; email: string; fullName: string }>(
    supabase, "employees", "id, email, fullName:full_name", "loadEmployeesFull",
  );
}

/** Upsert employees from Okta (the identity spine). Keyed on email. */
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
  // Collapse duplicate conflict keys within this batch (last wins). Postgres
  // ON CONFLICT cannot update the same row twice in one statement, and the same
  // (source, day, cost_type, entity_key, model) can legitimately arrive twice —
  // e.g. a Cursor user counted as both an active-user seat and a member seat.
  const byKey = new Map<string, ReturnType<typeof toRow>>();
  const toRow = (f: ResolvedFact) => ({
    source: f.source,
    day: f.day,
    cost_type: f.costType,
    entity_key: f.entityKey,
    cost_usd: f.costUsd,
    tokens: f.tokens ?? null,
    requests: f.requests ?? null,
    employee_id: f.employeeId,
    model: f.model ?? "",
  });
  for (const f of facts) {
    const r = toRow(f);
    byKey.set(`${r.source}|${r.day}|${r.cost_type}|${r.entity_key}|${r.model}`, r);
  }
  const rows = [...byKey.values()];
  const { error } = await supabase
    .from("spend_facts")
    .upsert(rows, { onConflict: "source,day,cost_type,entity_key,model" });
  if (error) throw new Error(`upsertSpendFacts: ${error.message}`);
  return rows.length;
}

/**
 * Snapshot-replace a source's facts for a [startDate, endDate) window without
 * a delete-then-insert hole: upsert the new facts FIRST, then delete only rows
 * whose conflict key is absent from the new snapshot. A crash between the two
 * steps leaves stale rows (healed by the next run) instead of a blank window.
 * No-ops on an empty snapshot — a transient empty vendor response must never
 * wipe existing data (gotcha #4). The window is exclusive-end, matching every
 * fetch window in this repo (deleting `.lte` endDate wiped a day the fetch
 * never covered — e.g. Aug 1 on a July backfill with ?to=2026-08-01).
 * Pass `opts.costType` to scope the prune to one cost type — other cost types
 * in the window are untouched.
 */
export async function replaceWindowFacts(
  supabase: SupabaseClient,
  source: string,
  window: { startDate: string; endDate: string },
  facts: ResolvedFact[],
  opts?: { costType?: CostType },
): Promise<number> {
  if (facts.length === 0) return 0;
  const written = await upsertSpendFacts(supabase, facts);

  const keep = new Set(facts.map((f) => `${f.day}|${f.costType}|${f.entityKey}|${f.model ?? ""}`));
  const stale: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from("spend_facts")
      .select("id, day, cost_type, entity_key, model")
      .eq("source", source);
    // Scoped replace: prune only within this cost type (e.g. a credits import
    // must never touch seat facts sharing the window).
    if (opts?.costType) query = query.eq("cost_type", opts.costType);
    const { data, error } = await query
      .gte("day", window.startDate)
      .lt("day", window.endDate)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`replaceWindowFacts(${source}): ${error.message}`);
    for (const r of data ?? []) {
      if (!keep.has(`${r.day}|${r.cost_type}|${r.entity_key}|${r.model ?? ""}`)) stale.push(r.id as string);
    }
    if (!data || data.length < PAGE) break;
  }
  for (let i = 0; i < stale.length; i += 500) {
    const { error } = await supabase.from("spend_facts").delete().in("id", stale.slice(i, i + 500));
    if (error) throw new Error(`replaceWindowFacts(${source}) delete: ${error.message}`);
  }
  return written;
}

export interface ResolvedModelUsage extends ModelUsageFact {
  employeeId: string | null;
}

/** Idempotent upsert of Cursor per-user/day top-model rows on (day, entity_key). */
export async function upsertCursorTopModels(
  supabase: SupabaseClient,
  rows: { day: string; entityKey: string; model: string; employeeId: string | null }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const r = rows.map((x) => ({ day: x.day, entity_key: x.entityKey, model: x.model, employee_id: x.employeeId }));
  const { error } = await supabase.from("cursor_top_model").upsert(r, { onConflict: "day,entity_key" });
  if (error) throw new Error(`upsertCursorTopModels: ${error.message}`);
  return r.length;
}

/**
 * Attach employee_id to Cursor model-usage facts via the same email→employee
 * resolution as spend facts. Unmatched rows keep employeeId null and their
 * email is collected for the "Unmatched" queue (never dropped).
 */
export function attachModelUsageEmployees(
  facts: ModelUsageFact[],
  employees: { id: string; email: string }[],
): { facts: ResolvedModelUsage[]; unmatched: string[] } {
  const unmatched = new Set<string>();
  const resolved = facts.map((f) => {
    const { employeeId } = matchIdentity(f.entityKey, employees);
    if (!employeeId) unmatched.add(f.entityKey);
    return { ...f, employeeId };
  });
  return { facts: resolved, unmatched: [...unmatched] };
}

/**
 * Idempotent upsert on the (day, entity_key, model) key. Upsert-only (never
 * delete-then-insert): an empty/partial API response can update or add but can
 * never wipe a day's adoption history.
 */
export async function upsertModelUsage(
  supabase: SupabaseClient,
  facts: ResolvedModelUsage[],
): Promise<number> {
  if (facts.length === 0) return 0;
  const rows = facts.map((f) => ({
    day: f.day,
    entity_key: f.entityKey,
    model: f.model,
    messages: f.messages,
    employee_id: f.employeeId,
  }));
  const { error } = await supabase
    .from("cursor_model_usage")
    .upsert(rows, { onConflict: "day,entity_key,model" });
  if (error) throw new Error(`upsertModelUsage: ${error.message}`);
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
  const { error } = await supabase
    .from("sync_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: result.status,
      rows_written: result.rowsWritten ?? 0,
      error_detail: result.error ?? null,
    })
    .eq("id", id);
  // Non-fatal (the sync itself succeeded/failed independently) but never silent
  // — a stuck "running" row misleads the Data Health page.
  if (error) console.warn(`finishSyncRun(${id}): ${error.message}`);
}

export async function saveRawPayload(
  supabase: SupabaseClient,
  source: string,
  syncRunId: string,
  payload: unknown,
) {
  const { error } = await supabase
    .from("raw_payloads")
    .insert({ source, sync_run_id: syncRunId, payload });
  // Non-fatal, but the "raw payloads can be replayed" guarantee shouldn't fail
  // silently.
  if (error) console.warn(`saveRawPayload(${source}): ${error.message}`);
}
