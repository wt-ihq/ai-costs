import type { ShapeFact } from "./shape";
import type { TrendPoint } from "./types";

/**
 * Projected spend. Two disciplines keep these honest:
 *  - FIXED cost types (seat, subscription) post in full on the 1st — the
 *    month's fixed cost is already known and is never extrapolated (a naive
 *    MTD × days ratio would wildly overshoot early in the month).
 *  - Only VARIABLE spend (overage, metered) extrapolates, from a run rate
 *    that excludes the trailing LAG_DAYS (Vercel and the credit export lag;
 *    counting those days biases the rate low).
 */
const FIXED = new Set(["seat", "subscription"]);
const LAG_DAYS = 2;
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface MonthEndProjection {
  month: string; // YYYY-MM being projected
  projectedUsd: number;
  fixedUsd: number;
  variableMtdUsd: number;
  lastMonthUsd: number | null; // previous month's actual total
  deltaPct: number | null;
  basis: "run-rate" | "previous-month";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const isVariable = (f: ShapeFact) => !FIXED.has(f.costType);
const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const daysInMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const prevMonthOf = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

/** Month-end forecast for `now`'s month, from (already period/vendor-filtered) facts. */
export function projectMonthEnd(facts: ShapeFact[], now: Date): MonthEndProjection | null {
  const month = monthOf(now);
  const prevMonth = prevMonthOf(month);
  const inMonth = facts.filter((f) => f.day.slice(0, 7) === month);
  const inPrev = facts.filter((f) => f.day.slice(0, 7) === prevMonth);
  if (inMonth.length === 0 && inPrev.length === 0) return null;

  const fixedUsd = round2(inMonth.filter((f) => !isVariable(f)).reduce((s, f) => s + f.costUsd, 0));
  const variableMtdUsd = round2(inMonth.filter(isVariable).reduce((s, f) => s + f.costUsd, 0));

  // Run-rate window: [month start, now − LAG_DAYS], as day-of-month numbers.
  const cutoff = new Date(now.getTime() - LAG_DAYS * 86_400_000);
  const windowDays = monthOf(cutoff) === month ? cutoff.getUTCDate() : 0;
  const cutoffDay = `${month}-${String(windowDays).padStart(2, "0")}`;
  const variableWindowUsd = inMonth
    .filter(isVariable)
    .filter((f) => windowDays > 0 && f.day <= cutoffDay)
    .reduce((s, f) => s + f.costUsd, 0);

  let rate: number;
  let basis: MonthEndProjection["basis"];
  if (windowDays >= 3) {
    rate = variableWindowUsd / windowDays;
    basis = "run-rate";
  } else {
    rate = inPrev.filter(isVariable).reduce((s, f) => s + f.costUsd, 0) / daysInMonth(prevMonth);
    basis = "previous-month";
  }

  const remainingDays = daysInMonth(month) - windowDays;
  // The lag days are projected, not dropped — but anything that DID post in
  // them still counts: never project below the actuals already on record.
  const projectedUsd = round2(fixedUsd + Math.max(variableMtdUsd, variableWindowUsd + rate * remainingDays));

  const lastMonthTotal = inPrev.reduce((s, f) => s + f.costUsd, 0);
  const lastMonthUsd = inPrev.length ? round2(lastMonthTotal) : null;
  const deltaPct = lastMonthUsd && lastMonthUsd !== 0 ? round2(((projectedUsd - lastMonthUsd) / lastMonthUsd) * 100) : null;

  return { month, projectedUsd, fixedUsd, variableMtdUsd, lastMonthUsd, deltaPct, basis };
}

/**
 * Dashed forward extension for month-granularity trends: least-squares fit
 * of the last ≤6 COMPLETE months' variable spend, clamped at 0, plus the
 * current month's (already known) fixed level. Returns [] when fewer than
 * 2 complete months carry variable data.
 */
export function projectTrend(facts: ShapeFact[], now: Date, horizonMonths = 3): TrendPoint[] {
  const month = monthOf(now);
  const byMonth = new Map<string, number>();
  for (const f of facts) {
    const m = f.day.slice(0, 7);
    if (m >= month || !isVariable(f)) continue; // complete months only
    byMonth.set(m, (byMonth.get(m) ?? 0) + f.costUsd);
  }
  const months = [...byMonth.keys()].sort().slice(-6);
  if (months.length < 2) return [];

  // Least squares over (index, monthly variable total).
  const n = months.length;
  const ys = months.map((m) => byMonth.get(m)!);
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  });
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;

  const fixedLevel = facts
    .filter((f) => f.day.slice(0, 7) === month && !isVariable(f))
    .reduce((s, f) => s + f.costUsd, 0);

  // Distance from the last fitted month to each projected month, skipping
  // the incomplete current month (its actual MTD bar stays on the chart).
  const [ly, lm] = months[n - 1].split("-").map(Number);
  const [cy, cm] = month.split("-").map(Number);
  const gap = (cy - ly) * 12 + (cm - lm); // ≥ 1
  return Array.from({ length: horizonMonths }, (_, k) => {
    const idx = n - 1 + gap + k + 1; // first projection lands AFTER the current month
    const d = new Date(Date.UTC(cy, cm - 1 + k + 1, 1));
    return {
      label: `${SHORT[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`,
      projected: round2(Math.max(0, intercept + slope * idx) + fixedLevel),
    };
  });
}
