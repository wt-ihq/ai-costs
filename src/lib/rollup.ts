import type { CostType, Vendor } from "@/lib/types";

/** Normalized fact for rollups (department resolved via the employee join). */
export interface RollupRow {
  day: string; // ISO date
  source: Vendor;
  costType: CostType;
  costUsd: number;
  department: string | null;
}

export const UNATTRIBUTED = "Unattributed";
const monthOf = (day: string) => day.slice(0, 7); // YYYY-MM

export const total = (rows: RollupRow[]) =>
  rows.reduce((s, r) => s + r.costUsd, 0);

export function byCostType(rows: RollupRow[]): Record<CostType, number> {
  const out: Record<CostType, number> = { seat: 0, overage: 0, metered: 0 };
  for (const r of rows) out[r.costType] += r.costUsd;
  return out;
}

function sumBy<K extends string | number>(
  rows: RollupRow[],
  key: (r: RollupRow) => K,
): { key: K; total: number }[] {
  const m = new Map<K, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.costUsd);
  return [...m.entries()]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total);
}

export const bySource = (rows: RollupRow[]) =>
  sumBy(rows, (r) => r.source).map((x) => ({ source: x.key as Vendor, total: x.total }));

export const byDepartment = (rows: RollupRow[]) =>
  sumBy(rows, (r) => r.department ?? UNATTRIBUTED).map((x) => ({
    department: x.key,
    total: x.total,
  }));

/** Stacked monthly series: one entry per month, a USD field per vendor. */
export function monthlyByVendor(
  rows: RollupRow[],
  months: string[],
): Array<{ month: string } & Partial<Record<Vendor, number>>> {
  const base = new Map(months.map((m) => [m, { month: m } as Record<string, number | string>]));
  for (const r of rows) {
    const bucket = base.get(monthOf(r.day));
    if (!bucket) continue;
    bucket[r.source] = ((bucket[r.source] as number) ?? 0) + r.costUsd;
  }
  return months.map((m) => base.get(m)!) as Array<{ month: string } & Partial<Record<Vendor, number>>>;
}

/** The last `n` month keys (YYYY-MM) ending at `end`, oldest first. */
export function lastNMonths(end: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}
