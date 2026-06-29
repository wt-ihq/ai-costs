import type { SupabaseClient } from "@supabase/supabase-js";
import { matchIdentity } from "@/lib/ingest/identity";
import { loadEmployees } from "@/lib/ingest/persist";

/**
 * Resolve a set of unmatched entity keys against the current roster, mirroring
 * the ingest-time logic (attachEmployees → matchIdentity). Only email-shaped
 * keys resolve; key/project ids attribute via owner maps, not here, so they
 * stay unmatched — exactly as a re-ingest would behave. Pure + testable.
 */
export function resolveKeys(
  keys: string[],
  employees: { id: string; email: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of keys) {
    const { employeeId } = matchIdentity(key, employees);
    if (employeeId) out.set(key, employeeId);
  }
  return out;
}

export interface ReattributeResult {
  unmatchedKeys: number; // distinct unmatched entity keys scanned
  resolvedKeys: number; // keys that now map to an employee
  rowsUpdated: number; // spend_facts rows backfilled with employee_id
}

/**
 * Re-run email→employee attribution over EXISTING unmatched spend_facts against
 * the current employees roster — no vendor fetch. After a roster change (e.g.
 * switching the identity spine to Okta, which adds people HiBob lacked), facts
 * ingested before those employees existed stay unmatched; this backfills the
 * ones that now resolve. Never touches already-attributed rows.
 */
export async function reattributeUnmatched(supabase: SupabaseClient): Promise<ReattributeResult> {
  const employees = await loadEmployees(supabase);

  // Collect distinct unmatched entity keys (PostgREST caps reads at 1000).
  const PAGE = 1000;
  const keys = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("entity_key")
      .is("employee_id", null)
      .order("entity_key")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`reattributeUnmatched (scan): ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) keys.add((r as { entity_key: string }).entity_key);
    if (data.length < PAGE) break;
  }

  const resolved = resolveKeys([...keys], employees);

  // One UPDATE per resolved key. An email key maps to the same employee across
  // every source, so we don't filter by source; guard on employee_id IS NULL so
  // we only ever backfill, never overwrite an existing attribution.
  let rowsUpdated = 0;
  for (const [key, employeeId] of resolved) {
    const { data, error } = await supabase
      .from("spend_facts")
      .update({ employee_id: employeeId })
      .eq("entity_key", key)
      .is("employee_id", null)
      .select("id");
    if (error) throw new Error(`reattributeUnmatched (update ${key}): ${error.message}`);
    rowsUpdated += data?.length ?? 0;
  }

  return { unmatchedKeys: keys.size, resolvedKeys: resolved.size, rowsUpdated };
}
