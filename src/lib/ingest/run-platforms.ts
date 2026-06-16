import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeAnthropic } from "@/lib/ingest/normalizers/anthropic";
import { normalizeOpenAI } from "@/lib/ingest/normalizers/openai";
import { fetchAnthropicCost, fetchAnthropicWorkspaces, type AnthropicFetcher, type DateWindow } from "@/lib/ingest/sources/anthropic";
import { fetchOpenAICost, type OpenAIFetcher } from "@/lib/ingest/sources/openai";
import {
  attachOwners,
  finishSyncRun,
  loadProjectOwners,
  saveRawPayload,
  startSyncRun,
  upsertSpendFacts,
} from "@/lib/ingest/persist";

export interface PlatformSyncResult {
  rowsWritten: number;
  unmatched: string[];
}

/** Anthropic Cost Report → metered facts attributed to each key's owner. */
export async function syncAnthropic(
  supabase: SupabaseClient,
  window: DateWindow,
  fetcher: AnthropicFetcher = fetchAnthropicCost,
): Promise<PlatformSyncResult> {
  const runId = await startSyncRun(supabase, "anthropic");
  try {
    // group_by workspace_id reconciles with the org total (verified) and makes
    // spend attributable per workspace.
    const raw = await fetcher({ ...window, groupBy: "workspace_id" });
    await saveRawPayload(supabase, "anthropic", runId, raw);

    // Register workspaces (id → name) into projects so spend is readable and
    // attributable; existing owner assignments are preserved (name-only upsert).
    try {
      const ws = (await fetchAnthropicWorkspaces()) as { data?: Array<{ id?: string; name?: string }> };
      const rows = (ws.data ?? [])
        .filter((w) => w.id)
        .map((w) => ({ vendor: "anthropic" as const, external_id: w.id!, name: w.name ?? w.id! }));
      if (rows.length) await supabase.from("projects").upsert(rows, { onConflict: "vendor,external_id" });
    } catch {
      // names are best-effort
    }

    const owners = await loadProjectOwners(supabase);
    const { facts, unmatched } = attachOwners(normalizeAnthropic(raw), owners);
    // Snapshot: clear this window's facts first so a grouping change can't leave
    // stale rows that double-count.
    await supabase.from("spend_facts").delete().eq("source", "anthropic").gte("day", window.startDate).lte("day", window.endDate);
    const rowsWritten = await upsertSpendFacts(supabase, facts);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten, unmatched };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** OpenAI costs → metered facts attributed to each project's owner. */
export async function syncOpenAI(
  supabase: SupabaseClient,
  window: DateWindow,
  fetcher: OpenAIFetcher = fetchOpenAICost,
): Promise<PlatformSyncResult> {
  const runId = await startSyncRun(supabase, "openai");
  try {
    const raw = await fetcher(window);
    await saveRawPayload(supabase, "openai", runId, raw);
    const owners = await loadProjectOwners(supabase);
    const { facts, unmatched } = attachOwners(normalizeOpenAI(raw), owners);
    await supabase.from("spend_facts").delete().eq("source", "openai").gte("day", window.startDate).lte("day", window.endDate);
    const rowsWritten = await upsertSpendFacts(supabase, facts);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten, unmatched };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
