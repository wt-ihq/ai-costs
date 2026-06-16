import type { SpendFact } from "@/lib/types";
import { SchemaDriftError, type Normalizer } from "@/lib/ingest/types";

/**
 * Anthropic Console — Cost Report (GET /v1/organizations/cost_report).
 * Real shape (confirmed against the org): time buckets, each with `results[]`.
 * `amount` is a decimal string; `workspace_id`/`model` are populated when the
 * request groups by them (null = org-aggregate). entity_key = workspace id (or
 * "org"); attribution flows via the workspace's owner downstream (spec §5).
 */
export interface AnthropicCostResponse {
  data: Array<{
    starting_at: string; // ISO datetime
    ending_at?: string;
    results: Array<{
      amount: string;
      currency?: string;
      workspace_id?: string | null;
      model?: string | null;
    }>;
  }>;
}

export const normalizeAnthropic: Normalizer<AnthropicCostResponse> = (raw) => {
  if (!raw || !Array.isArray(raw.data)) {
    throw new SchemaDriftError("anthropic", "missing `data` array");
  }
  const facts: SpendFact[] = [];
  for (const bucket of raw.data) {
    const day = (bucket.starting_at ?? "").slice(0, 10);
    for (const r of bucket.results ?? []) {
      const cost = Number(r.amount);
      if (!Number.isFinite(cost) || cost === 0) continue;
      facts.push({
        source: "anthropic",
        day,
        costType: "metered",
        entityKey: r.workspace_id ?? "org",
        costUsd: cost,
        model: r.model ?? "",
      });
    }
  }
  return facts;
};
