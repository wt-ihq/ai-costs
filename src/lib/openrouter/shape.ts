import type { OpenRouterRow, OpenRouterScope } from "@/lib/queries/openrouter";
import { enumerateBuckets, type Period } from "@/lib/explore/period";

export type { OpenRouterRow, OpenRouterScope };

export interface SpendTrendPoint {
  label: string;
  total: number; // USD
}

export interface OpenRouterData {
  total: number; // USD
  tokens: number;
  requests: number;
  people: number; // distinct members with usage in the period
  modelCount: number;
  topModel: string | null; // by spend
  trend: SpendTrendPoint[]; // total USD per bucket (model split lives in byModel)
  byModel: { model: string; cost: number; tokens: number; requests: number }[];
  byPerson: { name: string; cost: number; tokens: number; requests: number }[];
}

/** Unmatched emails stay visible as themselves; only the unkeyed bucket is anonymous. */
const personLabel = (r: OpenRouterRow) => r.personName ?? (r.entityKey === "unkeyed" ? "Unattributed" : r.entityKey);

/**
 * OpenRouter reports permaslug snapshots ("anthropic/claude-opus-5-20260723");
 * the date stamp splits one model into several series and floods the trend
 * legend. Trim it so snapshots merge for display.
 */
const displayModel = (model: string): string => (model || "(no model)").replace(/-20\d{6}$/, "");

/** Pure: slice the scope to the period and aggregate spend + usage. */
export function buildOpenRouterData(scope: OpenRouterScope, period: Period): OpenRouterData {
  const rows = scope.rows.filter((r) => r.day >= period.from && r.day < period.toExclusive);

  let total = 0;
  let tokens = 0;
  let requests = 0;
  const members = new Set<string>();
  const modelAgg = new Map<string, { cost: number; tokens: number; requests: number }>();
  const personAgg = new Map<string, { cost: number; tokens: number; requests: number }>();
  for (const r of rows) {
    total += r.costUsd;
    tokens += r.tokens;
    requests += r.requests;
    if (r.entityKey !== "unkeyed") members.add(r.entityKey);
    const model = displayModel(r.model);
    const m = modelAgg.get(model) ?? { cost: 0, tokens: 0, requests: 0 };
    m.cost += r.costUsd; m.tokens += r.tokens; m.requests += r.requests;
    modelAgg.set(model, m);
    const person = personLabel(r);
    const p = personAgg.get(person) ?? { cost: 0, tokens: 0, requests: 0 };
    p.cost += r.costUsd; p.tokens += r.tokens; p.requests += r.requests;
    personAgg.set(person, p);
  }

  // Total spend per bucket (the model split lives in byModel below).
  const allBuckets: SpendTrendPoint[] = enumerateBuckets(period).map((b) => ({
    label: b.label,
    total: Math.round(rows.reduce((s, r) => (r.day >= b.from && r.day < b.toExclusive ? s + r.costUsd : s), 0) * 100) / 100,
  }));
  // Clip empty edge buckets (months before the data starts, days/months still
  // in the future) so a young data set isn't a sliver in a mostly-blank year;
  // interior gaps are kept — a quiet month mid-range is real signal.
  const first = allBuckets.findIndex((p) => p.total > 0);
  let last = allBuckets.length - 1;
  while (last >= 0 && allBuckets[last].total === 0) last--;
  const trend = first === -1 ? [] : allBuckets.slice(first, last + 1);

  const byModel = [...modelAgg.entries()]
    .map(([model, agg]) => ({ model, ...agg }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  return {
    total,
    tokens,
    requests,
    people: members.size,
    modelCount: byModel.length,
    topModel: byModel[0]?.model ?? null,
    trend,
    byModel,
    byPerson: [...personAgg.entries()]
      .map(([name, agg]) => ({ name, ...agg }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
  };
}
