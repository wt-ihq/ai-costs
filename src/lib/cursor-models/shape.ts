import type { ModelUsageRow } from "@/lib/queries/cursor-models";
import { enumerateBuckets, type Period } from "@/lib/explore/period";
import { UNATTRIBUTED } from "@/lib/explore/shape";

export type { ModelUsageRow };

/** One stacked-trend bucket; series keys are model names, values are messages. */
export type UsageTrendPoint = { label: string } & Record<string, number | string>;

export interface ModelBar {
  key: string;
  label: string;
  value: number; // messages
  color: string;
}

export interface UsageRankRow {
  id: string;
  label: string;
  messages: number;
  sub?: string; // top model, or "N people"
  href?: string;
}

export interface UsageSummary {
  messages: number;
  activeUsers: number; // distinct attributed employees with usage
  modelCount: number;
  topModel: string | null;
}

export interface ModelUsageData {
  period: Period;
  earliest: string;
  summary: UsageSummary;
  trend: UsageTrendPoint[];
  composition: ModelBar[]; // messages by model
  people: UsageRankRow[];
  teams: UsageRankRow[];
}

const PALETTE = ["#6ea8fe", "#f59e0b", "#c084fc", "#34d399", "#f472b6", "#facc15", "#22d3ee", "#fb7185", "#a3e635", "#818cf8"];

/**
 * Deterministic per-model color. Known families get an on-brand hue (Claude →
 * Anthropic brown, GPT/o-series → OpenAI teal, Gemini → blue, "auto" → muted);
 * everything else hashes into a stable palette so the same model keeps its
 * color across periods and charts.
 */
export function modelColor(model: string): string {
  const m = model.toLowerCase();
  if (/(claude|sonnet|opus|haiku)/.test(m)) return "#d2845a";
  if (/(gpt|o1|o3|o4|chatgpt)/.test(m)) return "#10a37f";
  if (/gemini/.test(m)) return "#4285f4";
  if (m === "auto" || m === "(unknown)") return "#8b92a5";
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function filterByPeriod(rows: ModelUsageRow[], period: Period): ModelUsageRow[] {
  return rows.filter((r) => r.day >= period.from && r.day < period.toExclusive);
}

function sumByModel(rows: ModelUsageRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.model, (m.get(r.model) ?? 0) + r.messages);
  return m;
}

export function modelComposition(rows: ModelUsageRow[], topN = 12): ModelBar[] {
  const sorted = [...sumByModel(rows).entries()].sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const bars = head.map(([model, value]) => ({ key: model, label: model, value, color: modelColor(model) }));
  const otherTotal = rest.reduce((s, [, v]) => s + v, 0);
  if (otherTotal > 0) bars.push({ key: "__other", label: `Other (${rest.length})`, value: otherTotal, color: "#4b5263" });
  return bars;
}

/** Stacked trend of messages per model across the period's buckets. */
export function trendByModel(rows: ModelUsageRow[], period: Period): UsageTrendPoint[] {
  const buckets = enumerateBuckets(period);
  return buckets.map((b) => {
    const point: UsageTrendPoint = { label: b.label };
    for (const r of rows) {
      if (r.day >= b.from && r.day < b.toExclusive) {
        point[r.model] = ((point[r.model] as number) ?? 0) + r.messages;
      }
    }
    return point;
  });
}

export function summarize(rows: ModelUsageRow[]): UsageSummary {
  const byModel = sumByModel(rows);
  const messages = [...byModel.values()].reduce((s, v) => s + v, 0);
  const users = new Set<string>();
  for (const r of rows) if (r.employeeId) users.add(r.employeeId);
  const top = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];
  return { messages, activeUsers: users.size, modelCount: byModel.size, topModel: top?.[0] ?? null };
}

const topModelOf = (rows: ModelUsageRow[]): string | null => {
  const top = [...sumByModel(rows).entries()].sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? null;
};

/** People ranked by message volume, with their most-used model as the subline. */
export function rankPeople(rows: ModelUsageRow[]): UsageRankRow[] {
  const byPerson = new Map<string, ModelUsageRow[]>();
  for (const r of rows) {
    const id = r.employeeId ?? `unmatched`;
    (byPerson.get(id) ?? byPerson.set(id, []).get(id)!).push(r);
  }
  return [...byPerson.entries()]
    .map(([id, rs]) => {
      const messages = rs.reduce((s, r) => s + r.messages, 0);
      const name = id === "unmatched" ? "Unmatched users" : rs[0].fullName ?? "Unknown";
      const dept = rs[0].department ?? UNATTRIBUTED;
      return {
        id,
        label: name,
        messages,
        sub: topModelOf(rs) ?? undefined,
        href: id === "unmatched" ? undefined : `/explore/${encodeURIComponent(dept)}/${id}`,
      };
    })
    .sort((a, b) => b.messages - a.messages);
}

/** Teams (departments) ranked by message volume, with active-people count. */
export function rankTeams(rows: ModelUsageRow[]): UsageRankRow[] {
  const byTeam = new Map<string, ModelUsageRow[]>();
  for (const r of rows) {
    const dept = r.department ?? UNATTRIBUTED;
    (byTeam.get(dept) ?? byTeam.set(dept, []).get(dept)!).push(r);
  }
  return [...byTeam.entries()]
    .map(([dept, rs]) => {
      const people = new Set(rs.map((r) => r.employeeId ?? "unmatched")).size;
      return {
        id: dept,
        label: dept,
        messages: rs.reduce((s, r) => s + r.messages, 0),
        sub: `${people} ${people === 1 ? "person" : "people"}`,
        href: dept === UNATTRIBUTED ? undefined : `/explore/${encodeURIComponent(dept)}`,
      };
    })
    .sort((a, b) => b.messages - a.messages);
}

export function buildModelUsage(scope: { rows: ModelUsageRow[]; earliest: string }, period: Period): ModelUsageData {
  const rows = filterByPeriod(scope.rows, period);
  return {
    period,
    earliest: scope.earliest,
    summary: summarize(rows),
    trend: trendByModel(rows, period),
    composition: modelComposition(rows),
    people: rankPeople(rows),
    teams: rankTeams(rows),
  };
}
