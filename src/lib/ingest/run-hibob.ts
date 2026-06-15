import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeHibob } from "@/lib/ingest/normalizers/hibob";
import { fetchHibobPeople, type HibobFetcher } from "@/lib/ingest/sources/hibob";
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
    const employees = normalizeHibob(raw) as unknown as Record<string, unknown>[];
    const rowsWritten = await upsertEmployees(supabase, employees);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
