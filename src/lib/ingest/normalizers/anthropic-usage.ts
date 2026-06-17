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
 * Per-API-KEY cost: the Cost Report API gives the authoritative daily total but
 * can't group by api_key_id, so we price Usage-report tokens per key as RELATIVE
 * weights and scale each day's weights to the authoritative Cost API daily total
 * — exact total, estimated allocation. `costByDay` is in DOLLARS (the caller
 * converts the Cost API `amount`, which is in cents, via ÷100). If a day is
 * absent from `costByDay`, that day falls back to the raw list-price estimate.
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
