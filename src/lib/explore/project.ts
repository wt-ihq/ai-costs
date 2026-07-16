import type { ShapeFact } from "./shape";
import type { TrendPoint } from "./types";

/**
 * Projected spend — ONE model everywhere ("at the current pace"), so the
 * tile and the dashed trend line always tell the same story:
 *  - FIXED cost types (seat, subscription) post in full on the 1st — the
 *    month's fixed cost is already known and is never extrapolated (a naive
 *    MTD × days ratio would wildly overshoot early in the month). Future
 *    months assume the current fixed level.
 *  - Only VARIABLE spend (overage, metered) extrapolates, from a run rate
 *    that excludes the trailing LAG_DAYS (Vercel and the credit export lag;
 *    counting those days biases the rate low).
 */
const FIXED = new Set(["seat", "subscription"]);
/**
 * Sources whose usage arrives as a MONTHLY snapshot — one lump fact stamped
 * to the 1st (Claude Team's member-usage import). A lump is a monthly level,
 * not daily spend: feeding it into the daily run rate inflates projections
 * ~2-3× (whole month ÷ window days × month days). It projects like fixed —
 * counted once, repeated for future months, never extrapolated.
 */
const MONTHLY_SNAPSHOT_SOURCES = new Set(["claude_team"]);
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
  label: string; // "July" | "Q3 26" | "2026"
  compareLabel: "last month" | "last quarter" | "last year";
  projectedUsd: number;
  prevPeriodUsd: number | null; // previous period's actual total
  deltaPct: number | null;
  basis: "run-rate" | "previous-month";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Extrapolates from a daily run rate. */
const isDailyVariable = (f: ShapeFact) => !FIXED.has(f.costType) && !MONTHLY_SNAPSHOT_SOURCES.has(f.source);
/** Posts once per month at a known/assumed level: fixed cost types + monthly-snapshot usage. */
const isMonthlyLevel = (f: ShapeFact) => !isDailyVariable(f);
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

interface MonthModel {
  month: string; // now's YYYY-MM
  levelUsd: number; // monthly-level spend posted this month (fixed + snapshot lumps)
  variableMtdUsd: number;
  variableWindowUsd: number;
  windowDays: number;
  rate: number; // daily-variable $/day
  basis: PeriodProjection["basis"];
}

/** The shared current-pace model: this month's monthly level + a lag-adjusted daily-variable run rate. */
function monthModel(facts: ShapeFact[], now: Date): MonthModel | null {
  const month = monthOf(now);
  const prevMonth = addMonths(month, -1);
  const inMonth = facts.filter((f) => f.day.slice(0, 7) === month);
  const inPrevMonth = facts.filter((f) => f.day.slice(0, 7) === prevMonth);
  if (inMonth.length === 0 && inPrevMonth.length === 0) return null; // nothing to project

  const levelUsd = sum(inMonth.filter(isMonthlyLevel));
  const variableMtdUsd = sum(inMonth.filter(isDailyVariable));

  // Run-rate window: [month start, now − LAG_DAYS], as day-of-month numbers.
  const cutoff = new Date(now.getTime() - LAG_DAYS * 86_400_000);
  const windowDays = monthOf(cutoff) === month ? cutoff.getUTCDate() : 0;
  const cutoffDay = `${month}-${String(windowDays).padStart(2, "0")}`;
  const variableWindowUsd = sum(
    inMonth.filter(isDailyVariable).filter((f) => windowDays > 0 && f.day <= cutoffDay),
  );

  let rate: number;
  let basis: PeriodProjection["basis"];
  if (windowDays >= 3) {
    rate = variableWindowUsd / windowDays;
    basis = "run-rate";
  } else {
    rate = sum(inPrevMonth.filter(isDailyVariable)) / daysInMonth(prevMonth);
    basis = "previous-month";
  }

  return { month, levelUsd, variableMtdUsd, variableWindowUsd, windowDays, rate, basis };
}

/**
 * Forecast for the END OF THE SELECTED PERIOD (month, quarter, or year;
 * "all" collapses to the current month), from already period/vendor-filtered
 * facts. Months elapsed within the period count as actuals; the current
 * month projects fixed + run-rate; future months in the period assume the
 * current fixed level plus the run rate. Comparison is against the previous
 * period of the same length — suppressed when the data span doesn't reach
 * back that far (a partial base yields nonsense percentages). Only call with
 * a period that includes `now`.
 */
export function projectPeriodEnd(facts: ShapeFact[], now: Date, period: ProjectionPeriod): PeriodProjection | null {
  const m = monthModel(facts, now);
  if (!m) return null;
  const { month, levelUsd, rate, basis } = m;

  const remainingDays = daysInMonth(month) - m.windowDays;
  // The lag days are projected, not dropped — but anything that DID post in
  // them still counts: never project below the actuals already on record.
  const currentMonthUsd = levelUsd + Math.max(m.variableMtdUsd, m.variableWindowUsd + rate * remainingDays);

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
    for (let fm = addMonths(month, 1); `${fm}-01` < period.toExclusive; fm = addMonths(fm, 1)) {
      futureUsd += levelUsd + rate * daysInMonth(fm);
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
    prevFrom = `${addMonths(month, -1)}-01`;
    prevToExclusive = `${month}-01`;
  }

  // Only compare when the data span covers the WHOLE previous period —
  // against a partial base (data collection started mid-period) the delta
  // reads like "+19463% vs last year" and means nothing.
  const earliestMonth = facts.reduce((min, f) => (f.day < min ? f.day : min), facts[0].day).slice(0, 7);
  const prevFacts = prevFrom.slice(0, 7) >= earliestMonth ? inRange(facts, prevFrom, prevToExclusive) : [];
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
 * Future monthly totals at the current pace: this month's fixed level + the
 * run rate × that month's days. Deliberately the SAME model as
 * `projectPeriodEnd`, so a quarter/year tile equals the actual bars plus the
 * dashed line's months — one story, not two. (An earlier least-squares fit
 * over past months contradicted the tile and overshot whenever an early ramp
 * dominated the fit.)
 */
export function projectTrend(facts: ShapeFact[], now: Date, horizonMonths = 3): { month: string; projected: number }[] {
  const m = monthModel(facts, now);
  if (!m) return [];
  return Array.from({ length: horizonMonths }, (_, k) => {
    const fm = addMonths(m.month, k + 1);
    return { month: fm, projected: round2(m.levelUsd + m.rate * daysInMonth(fm)) };
  });
}
