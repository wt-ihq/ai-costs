import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeAnthropic } from "@/lib/ingest/normalizers/anthropic";
import { normalizeOpenAI } from "@/lib/ingest/normalizers/openai";
import { fetchAnthropicCost, type AnthropicFetcher, type DateWindow } from "@/lib/ingest/sources/anthropic";
import { fetchOpenAICost, type OpenAIFetcher } from "@/lib/ingest/sources/openai";
import {
  attachOwners,
  finishSyncRun,
  loadApiKeyOwners,
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
    const raw = await fetcher(window);
    await saveRawPayload(supabase, "anthropic", runId, raw);
    const owners = await loadApiKeyOwners(supabase);
    const { facts, unmatched } = attachOwners(normalizeAnthropic(raw), owners);
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
    const rowsWritten = await upsertSpendFacts(supabase, facts);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten, unmatched };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
