import type { SupabaseClient } from "@supabase/supabase-js";
import { syncCursor } from "@/lib/ingest/run-cursor";
import { syncCursorModels } from "@/lib/ingest/run-cursor-models";
import { CURSOR_ANALYTICS_ENABLED } from "@/lib/cursor-models/config";
import { syncAnthropic, syncOpenAI } from "@/lib/ingest/run-platforms";
import { syncHibob } from "@/lib/ingest/run-hibob";
import type { DateWindow } from "@/lib/ingest/sources/anthropic";

export type SyncOutcome = { ok: true; rowsWritten: number } | { ok: false; error: string };

/**
 * Run every source for a date window, isolated so one vendor's failure (e.g. a
 * missing API key) never aborts the others (spec §8). HiBob runs first as the
 * identity spine so freshly-synced employees are available for attribution.
 */
export async function runAllSyncs(
  supabase: SupabaseClient,
  window: DateWindow,
  only?: string[],
): Promise<Record<string, SyncOutcome>> {
  const results: Record<string, SyncOutcome> = {};
  const wants = only && only.length ? new Set(only) : null;
  // Sources skipped in the default daily run (no entitlement yet) but still
  // runnable on demand via ?source=<name>. cursor_models needs Cursor
  // Enterprise; see CURSOR_ANALYTICS_ENABLED.
  const optInOnly = new Set(CURSOR_ANALYTICS_ENABLED ? [] : ["cursor_models"]);
  const run = async (name: string, fn: () => Promise<{ rowsWritten: number }>) => {
    if (wants && !wants.has(name)) return;
    if (!wants && optInOnly.has(name)) return; // not explicitly requested → skip in default run
    try {
      results[name] = { ok: true, rowsWritten: (await fn()).rowsWritten };
    } catch (err) {
      results[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  await run("hibob", () => syncHibob(supabase));
  await Promise.all([
    run("cursor", () => syncCursor(supabase, window)),
    run("cursor_models", () => syncCursorModels(supabase, window)),
    run("anthropic", () => syncAnthropic(supabase, window)),
    run("openai", () => syncOpenAI(supabase, window)),
  ]);
  return results;
}

/** Trailing-N-day window ending today. */
export function recentWindow(now: Date, days = 7): DateWindow {
  return {
    startDate: new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
  };
}

/**
 * Current month-to-date window (1st of month → tomorrow, exclusive end). Used
 * by the daily cron so each run reloads the whole current month — snapshot
 * upserts make this self-healing: a missed day or restated vendor data can't
 * leave a gap in "this month".
 */
export function monthToDate(now: Date): DateWindow {
  return {
    startDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10),
    endDate: new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10),
  };
}
