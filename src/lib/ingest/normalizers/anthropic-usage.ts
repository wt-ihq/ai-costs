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
 * Price per-key token usage and scale each day's estimates to the authoritative
 * Cost API daily total. Result: an estimated per-(day, key, model) cost whose
 * daily sums exactly match the Cost API (exact total, estimated allocation).
 */
export function estimateAndScale(
  buckets: UsageBucket[],
  costByDay: Record<string, number>,
  price: (r: UsageResult) => number = priceUsageResult,
): EstimatedKeyCost[] {
  const agg = new Map<string, EstimatedKeyCost>();
  const estByDay: Record<string, number> = {};

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
      estByDay[day] = (estByDay[day] ?? 0) + est;
    }
  }

  return [...agg.values()].map((v) => {
    const dayCost = costByDay[v.day];
    const scale = dayCost != null && estByDay[v.day] > 0 ? dayCost / estByDay[v.day] : 1;
    return { ...v, costUsd: Math.round(v.costUsd * scale * 100) / 100 };
  });
}
