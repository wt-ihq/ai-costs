import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelUsageFact } from "@/lib/types";
import { normalizeCursorModels } from "@/lib/ingest/normalizers/cursor-models";
import { fetchCursorByUserModels, type CursorModelsFetcher } from "@/lib/ingest/sources/cursor-models";
import {
  attachModelUsageEmployees,
  finishSyncRun,
  loadEmployees,
  saveRawPayload,
  startSyncRun,
  upsertModelUsage,
} from "@/lib/ingest/persist";

export interface CursorModelsSyncResult {
  rowsWritten: number;
  unmatched: string[];
}

const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 28; // under the Analytics API's 30-day per-request cap

/**
 * Split [startDate, endDate) into windows of at most MAX_SPAN_DAYS days. The
 * Analytics API rejects ranges over 30 days, but the cron passes a whole
 * month-to-date window — so we chunk before fetching. Both bounds are
 * inclusive date strings for the API (endDate defaults to today server-side).
 */
export function chunkWindows(startDate: string, endDate: string): { startDate: string; endDate: string }[] {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [{ startDate, endDate }];
  }
  const windows: { startDate: string; endDate: string }[] = [];
  for (let from = start; from < end; from += MAX_SPAN_DAYS * DAY_MS) {
    const to = Math.min(from + (MAX_SPAN_DAYS - 1) * DAY_MS, end - DAY_MS);
    windows.push({
      startDate: new Date(from).toISOString().slice(0, 10),
      endDate: new Date(Math.max(to, from)).toISOString().slice(0, 10),
    });
  }
  return windows;
}

/**
 * Cursor model-adoption pipeline: fetch per ≤28-day chunk → persist raw →
 * normalize → resolve identities → upsert into cursor_model_usage → record the
 * sync run. This is usage volume (messages), NOT spend, so it never touches
 * spend_facts. The fetcher is injected so tests/proofs run against fixtures.
 */
export async function syncCursorModels(
  supabase: SupabaseClient,
  opts: { startDate: string; endDate: string },
  fetcher: CursorModelsFetcher = fetchCursorByUserModels,
): Promise<CursorModelsSyncResult> {
  const runId = await startSyncRun(supabase, "cursor_models");
  try {
    const employees = await loadEmployees(supabase);
    const allFacts: ModelUsageFact[] = [];
    for (const win of chunkWindows(opts.startDate, opts.endDate)) {
      const raw = await fetcher(win);
      await saveRawPayload(supabase, "cursor_models", runId, raw);
      allFacts.push(...normalizeCursorModels(raw));
    }
    const { facts: resolved, unmatched } = attachModelUsageEmployees(allFacts, employees);
    const rowsWritten = await upsertModelUsage(supabase, resolved);
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
