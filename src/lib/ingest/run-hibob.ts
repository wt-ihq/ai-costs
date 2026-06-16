import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeHibob, buildNamedListMap, resolveDepartments } from "@/lib/ingest/normalizers/hibob";
import { fetchHibobPeople, fetchHibobNamedList, type HibobFetcher } from "@/lib/ingest/sources/hibob";
import { finishSyncRun, saveRawPayload, startSyncRun, upsertEmployees } from "@/lib/ingest/persist";

/** HiBob People → employee upserts (the identity spine). Writes no facts. */
export async function syncHibob(
  supabase: SupabaseClient,
  fetcher: HibobFetcher = fetchHibobPeople,
): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "hibob");
  try {
    const raw = await fetcher();
    await saveRawPayload(supabase, "hibob", runId, raw);
    let employees = normalizeHibob(raw);
    // Resolve department list-item IDs to names (best-effort — keep IDs if the
    // named-list metadata isn't available to the service user).
    try {
      const deptMap = buildNamedListMap(await fetchHibobNamedList("department"));
      employees = resolveDepartments(employees, deptMap);
    } catch {
      // leave department IDs as-is
    }
    const rowsWritten = await upsertEmployees(supabase, employees as unknown as Record<string, unknown>[]);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
