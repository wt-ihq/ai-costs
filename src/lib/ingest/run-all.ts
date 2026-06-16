import type { SupabaseClient } from "@supabase/supabase-js";
import { syncCursor } from "@/lib/ingest/run-cursor";
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
): Promise<Record<string, SyncOutcome>> {
  const results: Record<string, SyncOutcome> = {};
  const run = async (name: string, fn: () => Promise<{ rowsWritten: number }>) => {
    try {
      results[name] = { ok: true, rowsWritten: (await fn()).rowsWritten };
    } catch (err) {
      results[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  await run("hibob", () => syncHibob(supabase));
  await Promise.all([
    run("cursor", () => syncCursor(supabase, window)),
    run("anthropic", () => syncAnthropic(supabase, window)),
    run("openai", () => syncOpenAI(supabase, window)),
  ]);
  return results;
}

/** Trailing-N-day window ending today (cron default). */
export function recentWindow(now: Date, days = 7): DateWindow {
  return {
    startDate: new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
  };
}
