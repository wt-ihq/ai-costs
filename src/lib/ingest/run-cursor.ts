import type { SupabaseClient } from "@supabase/supabase-js";
import type { SpendFact } from "@/lib/types";
import { normalizeCursor, normalizeCursorEvents, normalizeCursorMembers } from "@/lib/ingest/normalizers/cursor";
import {
  fetchCursorUsage,
  fetchCursorUsageEvents,
  fetchCursorMembers,
  type CursorFetcher,
  type CursorEventsFetcher,
  type CursorMembersFetcher,
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
  membersFetcher: CursorMembersFetcher = fetchCursorMembers,
): Promise<CursorSyncResult> {
  const runId = await startSyncRun(supabase, "cursor");
  try {
    const raw = await fetcher(opts);
    await saveRawPayload(supabase, "cursor", runId, raw);
    const seatFacts = normalizeCursor(raw);

    const rawEvents = await eventsFetcher(opts);
    await saveRawPayload(supabase, "cursor", runId, rawEvents);
    const overageFacts = normalizeCursorEvents(rawEvents);

    // The /teams/members roster is the authoritative seat list (includes
    // paid-but-idle members daily-usage-data omits), but it's date-less — it
    // reflects the *current* roster. So apply it only to the current month, and
    // only when the sync window actually covers it (a historical backfill must
    // not stamp current-month seats). It upserts on (cursor, month, seat,
    // email), unioning with any active-user seat for the same month.
    const memberSeatFacts = await currentMonthMemberSeats(supabase, runId, opts, membersFetcher);

    const employees = await loadEmployees(supabase);
    const { facts: resolved, unmatched } = attachEmployees([...seatFacts, ...overageFacts, ...memberSeatFacts], employees);

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

/**
 * Seat facts from the current roster, but only when the sync window includes
 * the current month (the roster is date-less / "now"). Returns [] otherwise so
 * historical backfills aren't polluted with present-day seats.
 */
async function currentMonthMemberSeats(
  supabase: SupabaseClient,
  runId: string,
  opts: { startDate: string; endDate: string },
  membersFetcher: CursorMembersFetcher,
): Promise<SpendFact[]> {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  if (!(month >= opts.startDate && month < opts.endDate)) return [];

  const rawMembers = await membersFetcher();
  await saveRawPayload(supabase, "cursor", runId, rawMembers);
  return normalizeCursorMembers(rawMembers, month);
}
