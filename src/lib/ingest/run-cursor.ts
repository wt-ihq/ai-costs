import type { SupabaseClient } from "@supabase/supabase-js";
import type { SpendFact } from "@/lib/types";
import { matchIdentity } from "@/lib/ingest/identity";
import { normalizeCursor, normalizeCursorEvents, normalizeCursorMembers, normalizeCursorTopModels } from "@/lib/ingest/normalizers/cursor";
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
  replaceWindowFacts,
  saveRawPayload,
  startSyncRun,
  upsertSpendFacts,
  upsertCursorTopModels,
} from "@/lib/ingest/persist";

type Window = { startDate: string; endDate: string };

/**
 * Days of usage events per Cursor request. A month-to-date fetch had grown past 30,000 events by
 * the second week (16 MB+): the nightly run overran the cron's 300 s and the raw payload failed to
 * save. Three-day chunks keep each response and payload small.
 */
export const EVENT_CHUNK_DAYS = 3;
/** The nightly run re-reads only the last few days of events (they self-date; older days are final). */
export const NIGHTLY_EVENT_DAYS = 3;

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** [start, end) split into consecutive exclusive-end chunks of at most `days` days. Pure. */
export function eventChunks(window: Window, days = EVENT_CHUNK_DAYS): Window[] {
  const out: Window[] = [];
  for (let s = window.startDate; s < window.endDate; s = addDays(s, days)) {
    const e = addDays(s, days);
    out.push({ startDate: s, endDate: e < window.endDate ? e : window.endDate });
  }
  return out;
}

/** The events part of a sync window: its last `days` days when given (the nightly run), else all of it. Pure. */
export function eventsWindow(window: Window, days?: number): Window {
  if (!days) return window;
  const start = addDays(window.endDate, -days);
  return { startDate: start > window.startDate ? start : window.startDate, endDate: window.endDate };
}

/**
 * On-demand usage → overage facts, one chunk at a time: fetch → save raw → normalize → attribute →
 * replace that chunk's overage rows. Replacing (not upserting) drops rows a corrected normalizer no
 * longer produces; a chunk Cursor answered with events but no on-demand spend is pruned too
 * (pruneWhenEmpty), while one with no events at all is left alone (gotcha #4). Each chunk stands
 * alone, so a run stopped part-way leaves finished chunks correct and the rest as they were.
 */
export async function syncCursorEvents(
  supabase: SupabaseClient,
  runId: string,
  window: Window,
  eventsFetcher: CursorEventsFetcher,
  employees: { id: string; email: string }[],
): Promise<{ rowsWritten: number; unmatched: string[] }> {
  let rowsWritten = 0;
  const unmatched = new Set<string>();
  for (const chunk of eventChunks(window)) {
    const rawEvents = await eventsFetcher(chunk);
    await saveRawPayload(supabase, "cursor", runId, rawEvents);
    const { facts, unmatched: u } = attachEmployees(normalizeCursorEvents(rawEvents), employees);
    u.forEach((k) => unmatched.add(k));
    rowsWritten += await replaceWindowFacts(supabase, "cursor", chunk, facts, {
      costType: "overage",
      pruneWhenEmpty: (rawEvents.usageEvents?.length ?? 0) > 0,
    });
  }
  return { rowsWritten, unmatched: [...unmatched] };
}

/** Rebuild one window's Cursor on-demand spend from the events API (Data → Sync; history corrections). */
export async function rebuildCursorOverage(
  supabase: SupabaseClient,
  window: Window,
  eventsFetcher: CursorEventsFetcher = fetchCursorUsageEvents,
): Promise<CursorSyncResult> {
  const runId = await startSyncRun(supabase, "cursor");
  try {
    const result = await syncCursorEvents(supabase, runId, window, eventsFetcher, await loadEmployees(supabase));
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten: result.rowsWritten });
    return result;
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

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
 * and filtered-usage-events → on-demand spend (overage facts, syncCursorEvents;
 * `eventsDays` limits those to the window's last days — the nightly run).
 * Raw payloads are saved BEFORE normalization so a normalizer bug can be
 * replayed without re-fetching.
 */
export async function syncCursor(
  supabase: SupabaseClient,
  opts: { startDate: string; endDate: string; eventsDays?: number },
  fetcher: CursorFetcher = fetchCursorUsage,
  eventsFetcher: CursorEventsFetcher = fetchCursorUsageEvents,
  membersFetcher: CursorMembersFetcher = fetchCursorMembers,
): Promise<CursorSyncResult> {
  const runId = await startSyncRun(supabase, "cursor");
  try {
    const window = { startDate: opts.startDate, endDate: opts.endDate };
    const raw = await fetcher(window);
    await saveRawPayload(supabase, "cursor", runId, raw);
    const seatFacts = normalizeCursor(raw);

    // The /teams/members roster is the authoritative seat list (includes
    // paid-but-idle members daily-usage-data omits), but it's date-less — it
    // reflects the *current* roster. So apply it only to the current month, and
    // only when the sync window actually covers it (a historical backfill must
    // not stamp current-month seats). It upserts on (cursor, month, seat,
    // email), unioning with any active-user seat for the same month.
    const memberSeatFacts = await currentMonthMemberSeats(supabase, runId, window, membersFetcher);

    const employees = await loadEmployees(supabase);
    const { facts: resolved, unmatched: seatUnmatched } = attachEmployees([...seatFacts, ...memberSeatFacts], employees);
    // Seats first: they don't depend on the usage events, so an events failure (e.g. a new event kind) can't hold them back.
    const seatRows = await upsertSpendFacts(supabase, resolved);
    const events = await syncCursorEvents(supabase, runId, eventsWindow(window, opts.eventsDays), eventsFetcher, employees);

    const rowsWritten = seatRows + events.rowsWritten;
    const unmatched = [...new Set([...seatUnmatched, ...events.unmatched])];

    // Teams-plan model signal: capture each user's daily most-used model from
    // the same daily-usage payload. Best-effort — a failure here (e.g. the
    // cursor_top_model table not yet migrated) must not fail the seat/overage
    // sync, which is the source of truth for spend.
    try {
      const topModels = normalizeCursorTopModels(raw).map((t) => ({
        ...t,
        employeeId: matchIdentity(t.entityKey, employees).employeeId,
      }));
      await upsertCursorTopModels(supabase, topModels);
    } catch {
      // ignore — model signal is non-critical
    }

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
 * Seat facts from the current roster, but only when the sync window overlaps
 * the current month (the roster is date-less / "now"). Returns [] otherwise so
 * historical backfills aren't polluted with present-day seats. Overlap (rather
 * than "window contains the 1st") means a mid-month manual run like
 * ?from=2026-07-03&to=2026-07-05 still refreshes the roster seats.
 */
async function currentMonthMemberSeats(
  supabase: SupabaseClient,
  runId: string,
  opts: { startDate: string; endDate: string },
  membersFetcher: CursorMembersFetcher,
): Promise<SpendFact[]> {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  // [startDate, endDate) must intersect [month, nextMonth).
  if (!(opts.endDate > month && opts.startDate < nextMonth)) return [];

  const rawMembers = await membersFetcher();
  await saveRawPayload(supabase, "cursor", runId, rawMembers);
  return normalizeCursorMembers(rawMembers, month);
}
