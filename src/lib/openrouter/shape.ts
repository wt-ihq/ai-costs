import type { OpenRouterRow, OpenRouterScope } from "@/lib/queries/openrouter";
import { enumerateBuckets, type Period } from "@/lib/explore/period";

export type { OpenRouterRow, OpenRouterScope };

export interface SpendTrendPoint {
  label: string;
  total: number; // USD
}

export interface PersonUsage {
  name: string;
  /** member = a person (or unmatched email); workspace = usage from a
   * workspace-owned API key; unattributed = the unkeyed drift bucket. */
  kind: "member" | "workspace" | "unattributed";
  cost: number;
  tokens: number;
  requests: number;
  models: { model: string; cost: number }[]; // per-user model split, cost desc
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
  byPerson: PersonUsage[]; // members only (incl. unmatched emails)
  byWorkspace: PersonUsage[]; // workspace-owned keys + the unkeyed drift remainder
}

/** Unmatched emails stay visible as themselves; only the unkeyed bucket is anonymous. */
const personLabel = (r: OpenRouterRow) => r.personName ?? (r.entityKey === "unkeyed" ? "Unattributed" : r.entityKey);

/** Workspace-keyed rows carry the workspace name (no "@") as entity_key. */
const personKind = (r: OpenRouterRow): PersonUsage["kind"] =>
  r.personName || r.entityKey.includes("@") ? "member" : r.entityKey === "unkeyed" ? "unattributed" : "workspace";

/**
 * OpenRouter reports permaslug snapshots ("anthropic/claude-opus-5-20260723");
 * the date stamp splits one model into several series and floods the trend
 * legend. Trim it so snapshots merge for display.
 */
const displayModel = (model: string): string => (model || "(no model)").replace(/-20\d{6}$/, "");

/** People are one list; workspace keys (and the unkeyed remainder) another — mixing them read as departments among names. */
function splitByKind(entries: PersonUsage[]): { byPerson: PersonUsage[]; byWorkspace: PersonUsage[] } {
  return {
    byPerson: entries.filter((e) => e.kind === "member"),
    byWorkspace: entries.filter((e) => e.kind !== "member"),
  };
}

/** Pure: slice the scope to the period and aggregate spend + usage. */
export function buildOpenRouterData(scope: OpenRouterScope, period: Period): OpenRouterData {
  const rows = scope.rows.filter((r) => r.day >= period.from && r.day < period.toExclusive);

  let total = 0;
  let tokens = 0;
  let requests = 0;
  const members = new Set<string>();
  const modelAgg = new Map<string, { cost: number; tokens: number; requests: number }>();
  const personAgg = new Map<string, { kind: PersonUsage["kind"]; cost: number; tokens: number; requests: number; models: Map<string, number> }>();
  for (const r of rows) {
    total += r.costUsd;
    tokens += r.tokens;
    requests += r.requests;
    if (personKind(r) === "member") members.add(r.entityKey);
    const model = displayModel(r.model);
    const m = modelAgg.get(model) ?? { cost: 0, tokens: 0, requests: 0 };
    m.cost += r.costUsd; m.tokens += r.tokens; m.requests += r.requests;
    modelAgg.set(model, m);
    const person = personLabel(r);
    const p = personAgg.get(person) ?? { kind: personKind(r), cost: 0, tokens: 0, requests: 0, models: new Map<string, number>() };
    p.cost += r.costUsd; p.tokens += r.tokens; p.requests += r.requests;
    p.models.set(model, (p.models.get(model) ?? 0) + r.costUsd);
    personAgg.set(person, p);
  }

  // Total spend per bucket (the model split lives in byModel below). The full
  // period is enumerated — empty buckets keep their axis slot with no bar —
  // exactly like the Explore trend.
  const trend: SpendTrendPoint[] = enumerateBuckets(period).map((b) => ({
    label: b.label,
    total: Math.round(rows.reduce((s, r) => (r.day >= b.from && r.day < b.toExclusive ? s + r.costUsd : s), 0) * 100) / 100,
  }));

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
    ...splitByKind(
      [...personAgg.entries()]
        .map(([name, { models, ...agg }]) => ({
          name,
          ...agg,
          models: [...models.entries()]
            .map(([model, cost]) => ({ model, cost }))
            .sort((a, b) => b.cost - a.cost),
        }))
        .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    ),
  };
}
