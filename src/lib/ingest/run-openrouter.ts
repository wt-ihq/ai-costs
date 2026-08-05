import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchOpenRouterActivity,
  fetchOpenRouterAnalytics,
  type OpenRouterActivityFetcher,
  type OpenRouterAnalyticsFetcher,
} from "@/lib/ingest/sources/openrouter";
import { applyActivityRemainder, normalizeOpenRouterAnalytics } from "@/lib/ingest/normalizers/openrouter";
import type { DateWindow } from "@/lib/ingest/sources/anthropic";
import { attachEmployees, finishSyncRun, loadEmployees, replaceWindowFacts, saveRawPayload, startSyncRun } from "@/lib/ingest/persist";

export interface OpenRouterSyncResult {
  rowsWritten: number;
  unmatched: string[];
}

/**
 * OpenRouter → per-member metered facts. The analytics query is the fact
 * source (per day × org-member email × model, with tokens/requests — the
 * first source to populate those columns); /activity is the drift check:
 * its authoritative day totals top up any analytics under-report as an
 * `unkeyed` fact. entity_key = member email, resolved to employees the same
 * way Cursor seats are.
 */
export async function syncOpenRouter(
  supabase: SupabaseClient,
  window: DateWindow,
  fetcher: OpenRouterAnalyticsFetcher = fetchOpenRouterAnalytics,
  activityFetcher: OpenRouterActivityFetcher = fetchOpenRouterActivity,
): Promise<OpenRouterSyncResult> {
  const runId = await startSyncRun(supabase, "openrouter");
  try {
    const raw = await fetcher(window);
    await saveRawPayload(supabase, "openrouter", runId, raw);
    let facts = normalizeOpenRouterAnalytics(raw, window);

    // Best-effort: the cross-check must not fail the sync when only the
    // secondary endpoint misbehaves — day totals just stay analytics-only.
    try {
      const activity = await activityFetcher();
      await saveRawPayload(supabase, "openrouter", runId, activity);
      facts = applyActivityRemainder(facts, activity, window);
    } catch (err) {
      console.warn(`syncOpenRouter: activity cross-check skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    const employees = await loadEmployees(supabase);
    const { facts: resolved, unmatched } = attachEmployees(facts, employees);

    // Snapshot-replace (upsert first, then prune stale keys); no-op on an
    // empty snapshot so a transient empty response can't wipe the window.
    const rowsWritten = await replaceWindowFacts(supabase, "openrouter", window, resolved);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten, unmatched };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
