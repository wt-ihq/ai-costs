import { priceUsageResult, type UsageResult } from "@/lib/ingest/pricing";

export interface UsageBucket {
  starting_at?: string;
  results?: UsageResult[];
}

export interface EstimatedKeyCost {
  day: string;
  apiKeyId: string | null; // null = unkeyed (e.g. Workbench)
  model: string;
  costUsd: number;
}

/**
 * Price per-key token usage at Anthropic's public list rates, aggregated per
 * (day, key, model). We deliberately do NOT scale to the Cost Report API: for
 * this org that endpoint returns physically impossible totals (~1000x the
 * list-price ceiling for the actual token volume — verified June 2026), so it
 * can't be trusted. The token-priced estimate is bounded by real token counts
 * (which DO match Claude's usage dashboard exactly) × public prices, and is the
 * cost we record. Absolute level = list price (per the chargeback decision).
 */
export function priceUsageByKey(
  buckets: UsageBucket[],
  price: (r: UsageResult) => number = priceUsageResult,
): EstimatedKeyCost[] {
  const agg = new Map<string, EstimatedKeyCost>();
  for (const b of buckets) {
    const day = (b.starting_at ?? "").slice(0, 10);
    if (!day) continue;
    for (const r of b.results ?? []) {
      const est = price(r);
      if (est <= 0) continue;
      const apiKeyId = r.api_key_id ?? null;
      const model = r.model ?? "";
      const k = `${day}|${apiKeyId ?? "unkeyed"}|${model}`;
      const cur = agg.get(k) ?? { day, apiKeyId, model, costUsd: 0 };
      cur.costUsd += est;
      agg.set(k, cur);
    }
  }
  return [...agg.values()].map((v) => ({ ...v, costUsd: Math.round(v.costUsd * 100) / 100 }));
}
