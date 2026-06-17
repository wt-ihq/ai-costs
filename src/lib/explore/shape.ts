import type { Vendor, CostType } from "@/lib/types";
import { VENDOR_COLORS, COST_TYPE_COLORS } from "@/lib/colors";
import { VENDOR_LABEL, COST_TYPE_LABEL } from "@/lib/types";
import type { Dim, TrendPoint, TreemapNode, RankRow, Scorecard } from "./types";
import { enumerateBuckets, type Period, type Bucket } from "./period";

export interface ShapeFact {
  day: string;
  source: Vendor;
  costType: CostType;
  costUsd: number;
  employeeId: string | null;
  department: string | null;
  fullName: string | null;
  entityKey: string;
  model: string;
}

export const UNATTRIBUTED = "Unattributed";

const dimKey = (r: ShapeFact, dim: Dim): string => (dim === "vendor" ? r.source : r.costType);
const labelFor = (dim: Dim, key: string) =>
  dim === "vendor" ? VENDOR_LABEL[key as Vendor] ?? key : COST_TYPE_LABEL[key as CostType] ?? key;
const colorFor = (dim: Dim, key: string) =>
  dim === "vendor" ? VENDOR_COLORS[key as Vendor] ?? "#6ea8fe" : COST_TYPE_COLORS[key as CostType] ?? "#6ea8fe";
const teamSlug = (dept: string) => encodeURIComponent(dept);
const sum = (rows: ShapeFact[]) => rows.reduce((s, r) => s + r.costUsd, 0);

function totalsBy(rows: ShapeFact[], key: (r: ShapeFact) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.costUsd);
  return m;
}

/** Period-scoped trend, adaptively bucketed (month→day, quarter→week, year→month). */
export function trendForPeriod(rows: ShapeFact[], period: Period, dim: Dim): TrendPoint[] {
  const buckets = enumerateBuckets(period);
  const points = new Map<string, TrendPoint>(buckets.map((b) => [b.key, { label: b.label }]));
  for (const r of rows) {
    if (r.day < period.from || r.day >= period.toExclusive) continue;
    const pt = points.get(bucketKey(r.day, period, buckets));
    if (!pt) continue;
    const k = dimKey(r, dim);
    pt[k] = ((pt[k] as number) ?? 0) + r.costUsd;
  }
  return buckets.map((b) => points.get(b.key)!);
}

function bucketKey(day: string, period: Period, buckets: Bucket[]): string {
  if (period.granularity === "month") return day;          // bucket key === the day
  if (period.granularity === "year" || period.granularity === "all") return day.slice(0, 7); // "YYYY-MM"
  const DAY_MS = 86_400_000;
  const idx = Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / (7 * DAY_MS));
  return buckets[Math.min(idx, buckets.length - 1)].key; // clamp into the clipped final week
}

/** Treemap nodes for a dim (or model), top-N by spend + an "Other" bucket. */
export function treemapByDim(rows: ShapeFact[], dim: Dim | "model", topN = 12): TreemapNode[] {
  const keyFn = dim === "model" ? (r: ShapeFact) => r.model || "(no model)" : (r: ShapeFact) => dimKey(r, dim);
  const totals = [...totalsBy(rows, keyFn).entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const head = totals.slice(0, topN);
  const rest = totals.slice(topN).reduce((s, [, v]) => s + v, 0);
  const nodes: TreemapNode[] = head.map(([key, value]) => ({
    key,
    label: dim === "model" ? key : labelFor(dim, key),
    value: Math.round(value * 100) / 100,
    color: dim === "model" ? "#6ea8fe" : colorFor(dim, key),
  }));
  if (rest > 0) nodes.push({ key: "__other__", label: "Other", value: Math.round(rest * 100) / 100, color: "#3a4150" });
  return nodes;
}

export function scorecardFor(rows: ShapeFact[]): Scorecard {
  const split = { seat: 0, overage: 0, metered: 0 } as Record<CostType, number>;
  for (const r of rows) split[r.costType] += r.costUsd;
  return { total: sum(rows), ...split };
}

/** Department rankings (rows already filtered to the period). */
export function rankTeams(rows: ShapeFact[], headcounts: Map<string, number>): RankRow[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const d = r.department ?? UNATTRIBUTED;
    totals.set(d, (totals.get(d) ?? 0) + r.costUsd);
  }
  return [...totals.entries()]
    .map(([dept, total]) => {
      const head = headcounts.get(dept) ?? 0;
      return {
        id: dept,
        label: dept,
        total: Math.round(total * 100) / 100,
        href: dept === UNATTRIBUTED ? undefined : `/explore/${teamSlug(dept)}`,
        perHead: dept === UNATTRIBUTED || head === 0 ? null : Math.round((total / head) * 100) / 100,
        sub: head ? `${head} people` : undefined,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** People rankings within a team (rows already filtered to team + period). */
export function rankPeople(
  rows: ShapeFact[],
  teamDept: string,
  employees: { id: string; fullName: string | null }[],
): RankRow[] {
  const agg = new Map<string, { total: number; seat: number; activity: number }>();
  for (const r of rows) {
    if (!r.employeeId) continue;
    const a = agg.get(r.employeeId) ?? { total: 0, seat: 0, activity: 0 };
    a.total += r.costUsd;
    if (r.costType === "seat") a.seat += r.costUsd;
    else a.activity += r.costUsd;
    agg.set(r.employeeId, a);
  }
  const nameById = new Map(employees.map((e) => [e.id, e.fullName ?? "(unknown)"]));
  return [...agg.entries()]
    .map(([id, a]) => ({
      id,
      label: nameById.get(id) ?? "(unknown)",
      total: Math.round(a.total * 100) / 100,
      idle: a.seat > 0 && a.activity === 0,
      sub: a.seat > 0 && a.activity === 0 ? "idle seat" : undefined,
      href: `/explore/${teamSlug(teamDept)}/${id}`,
    }))
    .sort((a, b) => b.total - a.total);
}

/** Company-wide: every employee with their (period-scoped) spend, roster-driven. */
export function rankAllStaff(
  rows: ShapeFact[],
  employees: { id: string; fullName: string | null; department: string | null }[],
): RankRow[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (!r.employeeId) continue;
    totals.set(r.employeeId, (totals.get(r.employeeId) ?? 0) + r.costUsd);
  }
  return employees
    .map((e) => {
      const dept = e.department ?? UNATTRIBUTED;
      return {
        id: e.id,
        label: e.fullName ?? "(unknown)",
        total: Math.round((totals.get(e.id) ?? 0) * 100) / 100,
        sub: dept,
        href: `/explore/${teamSlug(dept)}/${e.id}`,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** Individual leaf line items: vendor · cost-type · model/entity. */
export function lineItems(rows: ShapeFact[]): RankRow[] {
  const agg = new Map<string, number>();
  const meta = new Map<string, { source: Vendor; costType: CostType; detail: string }>();
  for (const r of rows) {
    const detail = r.model || r.entityKey || "—";
    const k = `${r.source}|${r.costType}|${detail}`;
    agg.set(k, (agg.get(k) ?? 0) + r.costUsd);
    meta.set(k, { source: r.source, costType: r.costType, detail });
  }
  return [...agg.entries()]
    .map(([k, total]) => {
      const m = meta.get(k)!;
      return { id: k, label: `${VENDOR_LABEL[m.source]} · ${m.costType} · ${m.detail}`, total: Math.round(total * 100) / 100 };
    })
    .sort((a, b) => b.total - a.total);
}
