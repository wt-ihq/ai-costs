import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCursor } from "@/lib/ingest/normalizers/cursor";
import { fetchCursorUsage, type CursorFetcher } from "@/lib/ingest/sources/cursor";
import {
  attachEmployees,
  finishSyncRun,
  loadEmployees,
  saveRawPayload,
  startSyncRun,
  upsertSpendFacts,
} from "@/lib/ingest/persist";

export interface CursorSyncResult {
  rowsWritten: number;
  unmatched: string[];
}

/**
 * Full Cursor pipeline (spec §6): fetch → persist raw → normalize →
 * resolve identities → upsert facts → record the sync run.
 *
 * `fetcher` is injected so tests/proofs run against fixtures; production passes
 * the live `fetchCursorUsage`. Raw payload is saved BEFORE normalization so a
 * normalizer bug can be replayed without re-fetching.
 */
export async function syncCursor(
  supabase: SupabaseClient,
  opts: { startDate: string; endDate: string },
  fetcher: CursorFetcher = fetchCursorUsage,
): Promise<CursorSyncResult> {
  const runId = await startSyncRun(supabase, "cursor");
  try {
    const raw = await fetcher(opts);
    await saveRawPayload(supabase, "cursor", runId, raw);

    const facts = normalizeCursor(raw);
    const employees = await loadEmployees(supabase);
    const { facts: resolved, unmatched } = attachEmployees(facts, employees);

    const rowsWritten = await upsertSpendFacts(supabase, resolved);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten, unmatched };
  } catch (err) {
    await finishSyncRun(supabase, runId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
