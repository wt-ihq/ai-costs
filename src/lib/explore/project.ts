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
const FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The slice of a Period the projection needs (month/all collapse to the current month). */
export interface ProjectionPeriod {
  granularity: "month" | "quarter" | "year" | "all";
  from: string; // YYYY-MM-DD inclusive
  toExclusive: string; // YYYY-MM-DD exclusive
  label: string; // "July 2026" | "Q3 2026" | "2026" | "All time"
}

export interface PeriodProjection {
  label: string; // "July" | "Q3 2026" | "2026"
  compareLabel: "last month" | "last quarter" | "last year";
  projectedUsd: number;
  prevPeriodUsd: number | null; // previous period's actual total
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
const addMonths = (ym: string, k: number) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7);
};
const sum = (facts: ShapeFact[]) => facts.reduce((s, f) => s + f.costUsd, 0);
const inRange = (facts: ShapeFact[], from: string, toExclusive: string) =>
  facts.filter((f) => f.day >= from && f.day < toExclusive);

/**
 * Forecast for the END OF THE SELECTED PERIOD (month, quarter, or year;
 * "all" collapses to the current month), from already period/vendor-filtered
 * facts. Months elapsed within the period count as actuals; the current
 * month projects fixed + run-rate; future months in the period assume the
 * current fixed level plus the run rate. Comparison is against the previous
 * period of the same length. Only call with a period that includes `now`.
 */
export function projectPeriodEnd(facts: ShapeFact[], now: Date, period: ProjectionPeriod): PeriodProjection | null {
  const month = monthOf(now);
  const prevMonth = addMonths(month, -1);
  const inMonth = facts.filter((f) => f.day.slice(0, 7) === month);
  const inPrevMonth = facts.filter((f) => f.day.slice(0, 7) === prevMonth);
  if (inMonth.length === 0 && inPrevMonth.length === 0) return null;

  const fixedUsd = sum(inMonth.filter((f) => !isVariable(f)));
  const variableMtdUsd = sum(inMonth.filter(isVariable));

  // Run-rate window: [month start, now − LAG_DAYS], as day-of-month numbers.
  const cutoff = new Date(now.getTime() - LAG_DAYS * 86_400_000);
  const windowDays = monthOf(cutoff) === month ? cutoff.getUTCDate() : 0;
  const cutoffDay = `${month}-${String(windowDays).padStart(2, "0")}`;
  const variableWindowUsd = sum(
    inMonth.filter(isVariable).filter((f) => windowDays > 0 && f.day <= cutoffDay),
  );

  let rate: number;
  let basis: PeriodProjection["basis"];
  if (windowDays >= 3) {
    rate = variableWindowUsd / windowDays;
    basis = "run-rate";
  } else {
    rate = sum(inPrevMonth.filter(isVariable)) / daysInMonth(prevMonth);
    basis = "previous-month";
  }

  const remainingDays = daysInMonth(month) - windowDays;
  // The lag days are projected, not dropped — but anything that DID post in
  // them still counts: never project below the actuals already on record.
  const currentMonthUsd = fixedUsd + Math.max(variableMtdUsd, variableWindowUsd + rate * remainingDays);

  const spansMonths = period.granularity === "quarter" || period.granularity === "year";
  let projectedUsd: number;
  let label: string;
  let compareLabel: PeriodProjection["compareLabel"];
  let prevFrom: string;
  let prevToExclusive: string;

  if (spansMonths) {
    // Elapsed months are actuals; future months assume the current fixed
    // level (seats/subscriptions are flat unless changed) plus the run rate.
    const pastActualUsd = sum(inRange(facts, period.from, `${month}-01`));
    let futureUsd = 0;
    for (let m = addMonths(month, 1); `${m}-01` < period.toExclusive; m = addMonths(m, 1)) {
      futureUsd += fixedUsd + rate * daysInMonth(m);
    }
    projectedUsd = round2(pastActualUsd + currentMonthUsd + futureUsd);
    label = period.label.replace(/ 20(\d\d)$/, " $1"); // "Q3 2026" → "Q3 26": keeps the tile header on one line
    compareLabel = period.granularity === "quarter" ? "last quarter" : "last year";
    const span = period.granularity === "quarter" ? 3 : 12;
    prevToExclusive = period.from;
    prevFrom = `${addMonths(period.from.slice(0, 7), -span)}-01`;
  } else {
    projectedUsd = round2(currentMonthUsd);
    label = FULL[Number(month.slice(5)) - 1];
    compareLabel = "last month";
    prevFrom = `${prevMonth}-01`;
    prevToExclusive = `${month}-01`;
  }

  const prevFacts = inRange(facts, prevFrom, prevToExclusive);
  const prevPeriodUsd = prevFacts.length ? round2(sum(prevFacts)) : null;
  const deltaPct = prevPeriodUsd ? round2(((projectedUsd - prevPeriodUsd) / prevPeriodUsd) * 100) : null;

  return { label, compareLabel, projectedUsd, prevPeriodUsd, deltaPct, basis };
}

/**
 * Dashed forward extension for month-granularity trend charts. Labels are
 * chosen to MATCH the chart's existing buckets so the line lands in the
 * right slots instead of appending duplicate categories:
 *  - year: fills the current year's remaining months ("Aug"…"Dec") — []
 *    when viewing a past year (nothing to project);
 *  - all: appends 3 future months in the all-time label style ("Aug 26").
 * Day/week granularities get no line ([]).
 */
export function projectTrendForPeriod(facts: ShapeFact[], now: Date, period: ProjectionPeriod): TrendPoint[] {
  const month = monthOf(now);
  if (period.granularity === "year") {
    if (period.from.slice(0, 4) !== month.slice(0, 4)) return []; // past year
    const horizon = 12 - Number(month.slice(5)); // through December
    return projectTrend(facts, now, horizon).map((p) => ({
      label: SHORT[Number(p.month.slice(5)) - 1],
      projected: p.projected,
    }));
  }
  if (period.granularity === "all") {
    return projectTrend(facts, now, 3).map((p) => ({
      label: `${SHORT[Number(p.month.slice(5)) - 1]} ${p.month.slice(2, 4)}`,
      projected: p.projected,
    }));
  }
  return [];
}

/**
 * Least-squares fit of the last ≤6 COMPLETE months' variable spend, clamped
 * at 0, plus the current month's (already known) fixed level. Returns [] when
 * fewer than 2 complete months carry variable data.
 */
export function projectTrend(facts: ShapeFact[], now: Date, horizonMonths = 3): { month: string; projected: number }[] {
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
    return {
      month: addMonths(month, k + 1),
      projected: round2(Math.max(0, intercept + slope * idx) + fixedLevel),
    };
  });
}
