import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeOpenAI } from "@/lib/ingest/normalizers/openai";
import { estimateAndScale, type UsageBucket } from "@/lib/ingest/normalizers/anthropic-usage";
import {
  fetchAnthropicCost,
  fetchAnthropicUsage,
  fetchAnthropicApiKeys,
  fetchAnthropicUsers,
  type DateWindow,
} from "@/lib/ingest/sources/anthropic";
import { fetchOpenAICost, type OpenAIFetcher } from "@/lib/ingest/sources/openai";
import {
  attachOwners,
  finishSyncRun,
  loadEmployees,
  loadProjectOwners,
  saveRawPayload,
  startSyncRun,
  upsertSpendFacts,
  type ResolvedFact,
} from "@/lib/ingest/persist";

export interface PlatformSyncResult {
  rowsWritten: number;
  unmatched: string[];
}

/**
 * Anthropic → per-API-KEY metered facts attributed to the key's creator.
 * The Cost API can't group by key, so we price Usage-report tokens per key and
 * SCALE each day to the authoritative Cost API total (exact total, estimated
 * allocation). Keys resolve to creators (created_by user → email → employee).
 */
export async function syncAnthropic(
  supabase: SupabaseClient,
  window: DateWindow,
): Promise<PlatformSyncResult> {
  const runId = await startSyncRun(supabase, "anthropic");
  try {
    // 1. Authoritative daily cost totals (org-level, paginated).
    const cost = await fetchAnthropicCost(window);
    await saveRawPayload(supabase, "anthropic", runId, cost);
    const costByDay: Record<string, number> = {};
    for (const b of cost.data) {
      const day = (b.starting_at ?? "").slice(0, 10);
      costByDay[day] = (costByDay[day] ?? 0) + b.results.reduce((s, r) => s + Number(r.amount), 0);
    }

    // 2. Per-key token usage, priced and scaled to the cost total.
    const usage = await fetchAnthropicUsage(window);
    const estimates = estimateAndScale(usage.data as UsageBucket[], costByDay);

    // 3. Resolve key → creator email → employee.
    const keysRaw = (await fetchAnthropicApiKeys()) as { data?: Array<{ id?: string; name?: string; created_by?: { id?: string } }> };
    const usersRaw = (await fetchAnthropicUsers()) as { data?: Array<{ id?: string; email?: string }> };
    const emailByUser = new Map((usersRaw.data ?? []).filter((u) => u.id).map((u) => [u.id!, (u.email ?? "").toLowerCase()]));
    const keyMeta = new Map(
      (keysRaw.data ?? []).filter((k) => k.id).map((k) => [k.id!, { name: k.name ?? k.id!, email: emailByUser.get(k.created_by?.id ?? "") ?? null }]),
    );
    const empByEmail = new Map((await loadEmployees(supabase)).map((e) => [e.email.toLowerCase(), e.id]));
    const empOf = (keyId: string | null) => {
      const email = keyId ? keyMeta.get(keyId)?.email : null;
      return email ? empByEmail.get(email) ?? null : null;
    };

    // Register keys (name + creator + owner) so the API Platforms page is readable.
    const keyRows = [...keyMeta.entries()].map(([id, m]) => ({
      vendor: "anthropic" as const,
      external_key_id: id,
      name: m.name,
      created_by_email: m.email,
      owner_employee_id: m.email ? empByEmail.get(m.email) ?? null : null,
    }));
    if (keyRows.length) await supabase.from("api_keys").upsert(keyRows, { onConflict: "vendor,external_key_id" });

    // 4. Build facts (entity = api key id, or "unkeyed" for Workbench usage).
    const unmatched = new Set<string>();
    const facts: ResolvedFact[] = estimates
      .filter((e) => e.costUsd > 0)
      .map((e) => {
        const employeeId = empOf(e.apiKeyId);
        const entityKey = e.apiKeyId ?? "unkeyed";
        if (!employeeId) unmatched.add(entityKey);
        return { source: "anthropic", day: e.day, costType: "metered", entityKey, costUsd: e.costUsd, model: e.model, employeeId };
      });

    await supabase.from("spend_facts").delete().eq("source", "anthropic").gte("day", window.startDate).lte("day", window.endDate);
    const rowsWritten = await upsertSpendFacts(supabase, facts);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten, unmatched: [...unmatched] };
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
