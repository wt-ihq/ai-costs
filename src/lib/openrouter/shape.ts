import type { OpenRouterRow, OpenRouterScope } from "@/lib/queries/openrouter";
import { enumerateBuckets, type Period } from "@/lib/explore/period";

export type { OpenRouterRow, OpenRouterScope };

export interface SpendTrendPoint {
  label: string;
  metered: number; // usage USD in the bucket
  subscription: number; // amortized platform-fee USD in the bucket
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
  total: number; // USD, usage + subscription
  usage: number; // metered USD only — the denominator for the lists' share bars
  subscription: number; // platform-fee USD in the period
  tokens: number;
  requests: number;
  people: number; // distinct members with usage in the period
  modelCount: number;
  topModel: string | null; // by spend
  trend: SpendTrendPoint[]; // per bucket, cost-type split (model split lives in byModel)
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
  const inPeriod = scope.rows.filter((r) => r.day >= period.from && r.day < period.toExclusive);
  // The platform subscription (month-stamped to the 1st) feeds the total and
  // the trend's amortized base; every per-model/per-person aggregation below
  // is usage only — a flat fee has no model or person.
  const subsRows = inPeriod.filter((r) => r.costType === "subscription");
  const rows = inPeriod.filter((r) => r.costType !== "subscription");
  const subscription = Math.round(subsRows.reduce((s, r) => s + r.costUsd, 0) * 100) / 100;

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

  // Per-bucket cost-type split, the full period enumerated (empty buckets
  // keep their axis slot) — exactly like the Explore trend. The subscription
  // is month-stamped to the 1st; on day/week buckets it's amortized evenly
  // across its month's days (Explore's monthly-level treatment), so the flat
  // base shows on every day instead of spiking the 1st.
  const buckets = enumerateBuckets(period);
  const points = buckets.map((b) => ({ label: b.label, metered: 0, subscription: 0 }));
  const bucketOf = (day: string) => buckets.findIndex((b) => day >= b.from && day < b.toExclusive);
  for (const r of rows) {
    const i = bucketOf(r.day);
    if (i >= 0) points[i].metered += r.costUsd;
  }
  const DAY_MS = 86_400_000;
  const amortize = period.granularity === "month" || period.granularity === "quarter";
  for (const s of subsRows) {
    if (!amortize) {
      const i = bucketOf(s.day);
      if (i >= 0) points[i].subscription += s.costUsd;
      continue;
    }
    const [y, m] = s.day.slice(0, 7).split("-").map(Number);
    const start = Date.parse(`${s.day.slice(0, 7)}-01T00:00:00Z`);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let d = 0; d < days; d++) {
      const i = bucketOf(new Date(start + d * DAY_MS).toISOString().slice(0, 10));
      if (i >= 0) points[i].subscription += s.costUsd / days;
    }
  }
  const trend: SpendTrendPoint[] = points.map((p) => ({
    label: p.label,
    metered: Math.round(p.metered * 100) / 100,
    subscription: Math.round(p.subscription * 100) / 100,
  }));

  const byModel = [...modelAgg.entries()]
    .map(([model, agg]) => ({ model, ...agg }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  return {
    total: Math.round((total + subscription) * 100) / 100,
    usage: Math.round(total * 100) / 100,
    subscription,
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
