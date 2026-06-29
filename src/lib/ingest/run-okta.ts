import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeOkta } from "@/lib/ingest/normalizers/okta";
import { fetchOktaUsers, type OktaFetcher } from "@/lib/ingest/sources/okta";
import { finishSyncRun, saveRawPayload, startSyncRun, upsertEmployees } from "@/lib/ingest/persist";

/**
 * Okta identity pipeline (replaces HiBob): fetch users → persist raw →
 * normalize → upsert employees (keyed on email). Department comes straight from
 * the Okta profile, so there's no named-list resolution step. The fetcher is
 * injected so tests/proofs run against fixtures.
 */
export async function syncOkta(
  supabase: SupabaseClient,
  fetcher: OktaFetcher = fetchOktaUsers,
): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "okta");
  try {
    const raw = await fetcher();
    await saveRawPayload(supabase, "okta", runId, raw);
    const employees = normalizeOkta(raw);
    const rowsWritten = await upsertEmployees(supabase, employees as unknown as Record<string, unknown>[]);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
