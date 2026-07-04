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
  replaceWindowFacts,
  saveRawPayload,
  startSyncRun,
  type ResolvedFact,
} from "@/lib/ingest/persist";

export interface PlatformSyncResult {
  rowsWritten: number;
  unmatched: string[];
}

/**
 * Anthropic → per-API-KEY metered facts attributed to the key's creator.
 * The Cost Report API gives the authoritative daily total (its `amount` is in
 * CENTS — divide by 100) but can't group by api_key_id; so we price Usage-report
 * tokens per key as relative weights and SCALE each day to the Cost API total
 * (exact total, estimated allocation). Keys resolve to creators (created_by
 * user → email → employee).
 */
export async function syncAnthropic(
  supabase: SupabaseClient,
  window: DateWindow,
): Promise<PlatformSyncResult> {
  const runId = await startSyncRun(supabase, "anthropic");
  try {
    // 1. Authoritative daily cost totals (org-level, paginated). `amount` is in
    //    cents per the API spec, so convert to dollars.
    const cost = await fetchAnthropicCost(window);
    await saveRawPayload(supabase, "anthropic", runId, cost);
    const costByDay: Record<string, number> = {};
    for (const b of cost.data) {
      const day = (b.starting_at ?? "").slice(0, 10);
      costByDay[day] = (costByDay[day] ?? 0) + b.results.reduce((s, r) => s + Number(r.amount), 0) / 100;
    }

    // 2. Per-key token usage as relative weights, scaled to the cost total.
    const usage = await fetchAnthropicUsage(window);
    await saveRawPayload(supabase, "anthropic", runId, usage);
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
    if (keyRows.length) {
      const { error } = await supabase.from("api_keys").upsert(keyRows, { onConflict: "vendor,external_key_id" });
      if (error) console.warn(`syncAnthropic api_keys upsert: ${error.message}`);
    }

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

    // Days the Cost API reports but the usage report doesn't cover (e.g.
    // non-token costs, or an empty usage response for one day) would otherwise
    // be silently dropped — keep the authoritative daily total by writing the
    // remainder as an unkeyed fact.
    const coveredDays = new Set(facts.map((f) => f.day));
    for (const [day, usd] of Object.entries(costByDay)) {
      if (usd > 0.005 && !coveredDays.has(day)) {
        unmatched.add("unkeyed");
        facts.push({ source: "anthropic", day, costType: "metered", entityKey: "unkeyed", costUsd: Math.round(usd * 100) / 100, model: "", employeeId: null });
      }
    }

    // Snapshot-replace (upsert first, then prune stale keys) ONLY when we have
    // facts. A transient empty usage response must not wipe the window's
    // existing data (which is what blanked a month previously).
    const rowsWritten = await replaceWindowFacts(supabase, "anthropic", window, facts);
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
    // Snapshot-replace (upsert first, then prune stale keys) only when we have
    // facts (don't wipe on a transient empty).
    const rowsWritten = await replaceWindowFacts(supabase, "openai", window, facts);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten, unmatched };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
