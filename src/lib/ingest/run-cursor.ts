import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCursor, normalizeCursorEvents } from "@/lib/ingest/normalizers/cursor";
import {
  fetchCursorUsage,
  fetchCursorUsageEvents,
  type CursorFetcher,
  type CursorEventsFetcher,
} from "@/lib/ingest/sources/cursor";
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
 * Fetchers are injected so tests/proofs run against fixtures; production passes
 * the live ones. Two complementary sources: daily-usage-data → $40/seat facts,
 * and filtered-usage-events → usage-based "additional" spend (overage facts).
 * Raw payloads are saved BEFORE normalization so a normalizer bug can be
 * replayed without re-fetching.
 */
export async function syncCursor(
  supabase: SupabaseClient,
  opts: { startDate: string; endDate: string },
  fetcher: CursorFetcher = fetchCursorUsage,
  eventsFetcher: CursorEventsFetcher = fetchCursorUsageEvents,
): Promise<CursorSyncResult> {
  const runId = await startSyncRun(supabase, "cursor");
  try {
    const raw = await fetcher(opts);
    await saveRawPayload(supabase, "cursor", runId, raw);
    const seatFacts = normalizeCursor(raw);

    const rawEvents = await eventsFetcher(opts);
    await saveRawPayload(supabase, "cursor", runId, rawEvents);
    const overageFacts = normalizeCursorEvents(rawEvents);

    const employees = await loadEmployees(supabase);
    const { facts: resolved, unmatched } = attachEmployees([...seatFacts, ...overageFacts], employees);

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
