import { isMonthlyLevelFact, type ShapeFact } from "./shape";
import type { TrendPoint } from "./types";

/**
 * Projected spend — ONE model everywhere ("at the current pace and
 * direction"), so the tile and the dashed trend line always tell the same
 * story:
 *  - FIXED cost types (seat, subscription) post in full on the 1st — the
 *    month's fixed cost is already known and is never extrapolated (a naive
 *    MTD × days ratio would wildly overshoot early in the month). Future
 *    months assume the current fixed level.
 *  - VARIABLE spend (overage, metered) extrapolates from a daily run rate,
 *    PER SOURCE, each over its OWN data horizon: a manual import that last
 *    covered the 10th must divide by 10 days, not by the days elapsed —
 *    days after a source's last data day are unknown, not zero.
 *  - Each source's observed pace is BLENDED with its previous-month rate
 *    (shrinkage, τ = BLEND_PRIOR_DAYS), so two hot days early in a month
 *    don't project a hot year, and the blend fades as real days accumulate.
 *  - A DAMPED TREND factor (median month-over-month growth of recent
 *    complete months, damped toward 1 and clamped) bends future months in
 *    the direction the spend has been moving — gently, never runaway.
 */
/** Trailing days excluded from every window — live syncs may have posted only part of them. */
const LAG_DAYS = 2;
/** Shrinkage prior: the previous month's rate carries the weight of this many observed days. */
const BLEND_PRIOR_DAYS = 10;
/** Trend: look back over this many complete months for month-over-month ratios. */
const TREND_LOOKBACK_MONTHS = 4;
/** Trend damping: how much of the observed growth carries forward (0 = none, 1 = full). */
const TREND_DAMPING = 0.5;
/** Month-over-month moves within ±this fraction are neutral for direction consensus. */
const TREND_DEADBAND = 0.05;
/** Per-month growth clamp after damping, and the cumulative cap across the horizon. */
const TREND_CLAMP = { perMonth: [0.8, 1.2], cumulative: [0.5, 2.0] } as const;

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
  label: string; // "July" | "Q3 26" | "’26"
  compareLabel: "last month" | "last quarter" | "last year";
  projectedUsd: number;
  lowUsd: number;
  highUsd: number;
  prevPeriodUsd: number | null; // previous period's actual total
  deltaPct: number | null;
  basis: "run-rate" | "previous-month";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, n));
/** Extrapolates from a daily run rate. */
const isDailyVariable = (f: ShapeFact) => !isMonthlyLevelFact(f);
/** Posts once per month at a known/assumed level: fixed cost types + monthly-snapshot usage. */
const isMonthlyLevel = isMonthlyLevelFact;
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

interface SourceRate {
  mtdUsd: number; // variable posted this month (incl. days past the window)
  windowDays: number;
  windowUsd: number;
  rate: number; // blended $/day
  lowRate: number; // conservative reading (min of pace / prior / blend)
  highRate: number; // aggressive reading (max of pace / prior / blend)
}

type Reading = "low" | "point" | "high";
const rateOf = (s: SourceRate, r: Reading) => (r === "low" ? s.lowRate : r === "high" ? s.highRate : s.rate);

interface MonthModel {
  month: string; // now's YYYY-MM
  levelUsd: number; // monthly-level spend posted this month (fixed + snapshot lumps)
  sources: SourceRate[];
  growth: number; // damped per-month trend factor (1 = flat)
  basis: PeriodProjection["basis"];
}

/**
 * The shared current-pace model. Per variable source: a run-rate window
 * ending at min(source's data horizon, now − LAG_DAYS), blended with the
 * source's previous-month daily rate when one exists. Plus one aggregate
 * damped trend factor from recent complete months.
 *
 * `sourceHorizons` (source → last day with data, GLOBAL, not scope-filtered)
 * matters on filtered views: a person's last credit row may be the 5th while
 * the import covers the 11th — the days between are genuinely zero for them,
 * not unknown. Without the map, the scope's own last fact day is the best
 * available horizon.
 */
function monthModel(facts: ShapeFact[], now: Date, sourceHorizons?: Record<string, string>): MonthModel | null {
  const month = monthOf(now);
  const prevMonth = addMonths(month, -1);
  const inMonth = facts.filter((f) => f.day.slice(0, 7) === month);
  const inPrevMonth = facts.filter((f) => f.day.slice(0, 7) === prevMonth);
  if (inMonth.length === 0 && inPrevMonth.length === 0) return null; // nothing to project

  const levelUsd = sum(inMonth.filter(isMonthlyLevel));

  const cutoff = new Date(now.getTime() - LAG_DAYS * 86_400_000);
  const cutoffDay = monthOf(cutoff) === month ? cutoff.toISOString().slice(0, 10) : `${month}-00`;

  const variable = facts.filter(isDailyVariable);
  const bySource = new Map<string, ShapeFact[]>();
  for (const f of variable) {
    const list = bySource.get(f.source) ?? [];
    list.push(f);
    bySource.set(f.source, list);
  }

  const sources: SourceRate[] = [...bySource.entries()]
    .filter(([, rows]) => rows.some((f) => f.day >= `${prevMonth}-01`)) // dormant sources project nothing
    .map(([source, rows]) => {
      const cur = rows.filter((f) => f.day.slice(0, 7) === month);
      const prev = rows.filter((f) => f.day.slice(0, 7) === prevMonth);
      const mtdUsd = sum(cur);
      // The window ends at the source's data horizon (staleness-aware): the
      // global last-data day when known — never before a day the scope itself
      // has facts on, never past the global cutoff (partial live days).
      const lastScopeDay = cur.reduce((max, f) => (f.day > max ? f.day : max), "");
      const horizon = sourceHorizons?.[source];
      const lastDay = horizon && horizon > lastScopeDay ? horizon : lastScopeDay;
      const windowEnd = lastDay < cutoffDay ? lastDay : cutoffDay;
      const windowDays = windowEnd.slice(0, 7) === month ? Number(windowEnd.slice(8)) : 0;
      const windowUsd = windowDays > 0 ? sum(cur.filter((f) => f.day <= windowEnd)) : 0;

      // A gap month is a ZERO prior, not a missing one: when the source has
      // older history but nothing last month, last month really was $0 —
      // without this, one hot fortnight after a quiet month projected as if
      // the quiet month never happened.
      const hasHistory = rows.some((f) => f.day < `${prevMonth}-01`);
      const prevDaily = prev.length ? sum(prev) / daysInMonth(prevMonth) : hasHistory ? 0 : null;
      let rate: number;
      if (windowDays > 0 && prevDaily !== null) {
        // Shrinkage: last month's rate carries BLEND_PRIOR_DAYS of weight.
        rate = (windowUsd + prevDaily * BLEND_PRIOR_DAYS) / (windowDays + BLEND_PRIOR_DAYS);
      } else if (windowDays > 0) {
        rate = windowUsd / windowDays;
      } else {
        rate = prevDaily ?? 0; // no current window: last month's pace, or a dead source
      }
      // The range spans the model's candidate readings: the observed pace,
      // the prior, and the blend between them. One reading → no range.
      const candidates = [rate, ...(windowDays > 0 ? [windowUsd / windowDays] : []), ...(prevDaily !== null ? [prevDaily] : [])];
      return { mtdUsd, windowDays, windowUsd, rate, lowRate: Math.min(...candidates), highRate: Math.max(...candidates) };
    });

  const basis: PeriodProjection["basis"] = sources.some((s) => s.windowDays >= 3) ? "run-rate" : "previous-month";

  return { month, levelUsd, sources, growth: trendGrowth(variable, month), basis };
}

/**
 * Damped aggregate trend: median month-over-month ratio of variable totals
 * across the last TREND_LOOKBACK complete months (consecutive pairs only —
 * a gap breaks the ratio), damped toward 1, clamped per month. 1 when the
 * history can't support a ratio — or when the ratios DISAGREE on direction:
 * a median of mixed up/down months is noise, and compounding noise for five
 * months once bent a flat vendor visibly upward. Moves within ±5% count as
 * neutral (neither confirming nor breaking consensus).
 */
function trendGrowth(variable: ShapeFact[], month: string): number {
  const totals = new Map<string, number>();
  for (const f of variable) totals.set(f.day.slice(0, 7), (totals.get(f.day.slice(0, 7)) ?? 0) + f.costUsd);
  const ratios: number[] = [];
  for (let k = -TREND_LOOKBACK_MONTHS + 1; k <= -1; k++) {
    const a = totals.get(addMonths(month, k - 1));
    const b = totals.get(addMonths(month, k));
    if (a && b && a > 0 && b > 0) ratios.push(b / a);
  }
  if (ratios.length === 0) return 1;
  const up = ratios.some((r) => r > 1 + TREND_DEADBAND);
  const down = ratios.some((r) => r < 1 - TREND_DEADBAND);
  if (up === down) return 1; // mixed signals, or nothing but neutral drift
  ratios.sort((x, y) => x - y);
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return clamp(1 + (median - 1) * TREND_DAMPING, TREND_CLAMP.perMonth);
}

/** The current month's projected finish. Per source: never below what already posted
 * (the days past a window still count), plus the rate over the unobserved days. */
function currentMonthProjection(m: MonthModel, reading: Reading = "point"): number {
  const dim = daysInMonth(m.month);
  const variable = m.sources.reduce(
    (s, src) => s + Math.max(src.mtdUsd, src.windowUsd + rateOf(src, reading) * (dim - src.windowDays)),
    0,
  );
  return m.levelUsd + variable;
}

export interface FutureMonth {
  month: string;
  projected: number;
  low: number;
  high: number;
}

/** Months AFTER the current one, at the current level + trend-bent rates.
 * The single producer for both the tile's future sum and the dashed line.
 * The low reading never gets an upward trend and the high never a downward
 * one — the range brackets the point estimate by construction. */
function futureMonths(m: MonthModel, count: number): FutureMonth[] {
  const total = (r: Reading) => m.sources.reduce((s, src) => s + rateOf(src, r), 0);
  const growthOf: Record<Reading, number> = { low: Math.min(m.growth, 1), point: m.growth, high: Math.max(m.growth, 1) };
  const monthUsd = (r: Reading, k: number, fm: string) =>
    round2(m.levelUsd + total(r) * daysInMonth(fm) * clamp(growthOf[r] ** (k + 1), TREND_CLAMP.cumulative));
  return Array.from({ length: count }, (_, k) => {
    const fm = addMonths(m.month, k + 1);
    return { month: fm, projected: monthUsd("point", k, fm), low: monthUsd("low", k, fm), high: monthUsd("high", k, fm) };
  });
}

/** "Q3 2026" → "Q3 26", "2026" → "’26": keeps the tile header on one line. */
const shortLabel = (label: string) => label.replace(/ 20(\d\d)$/, " $1").replace(/^20(\d\d)$/, "’$1");

/**
 * Forecast for the END OF THE SELECTED PERIOD (month, quarter, or year;
 * "all" collapses to the current month), from already period/vendor-filtered
 * facts. Months elapsed within the period count as actuals; the current
 * month projects level + blended run-rates; future months in the period get
 * the same rates bent by the damped trend. Comparison is against the
 * previous period of the same length — suppressed when the data span doesn't
 * reach back that far (a partial base yields nonsense percentages). Only
 * call with a period that includes `now`.
 */
export function projectPeriodEnd(facts: ShapeFact[], now: Date, period: ProjectionPeriod, sourceHorizons?: Record<string, string>): PeriodProjection | null {
  const m = monthModel(facts, now, sourceHorizons);
  if (!m) return null;
  const { month, basis } = m;

  const spansMonths = period.granularity === "quarter" || period.granularity === "year";
  let projectedUsd: number;
  let lowUsd: number;
  let highUsd: number;
  let label: string;
  let compareLabel: PeriodProjection["compareLabel"];
  let prevFrom: string;
  let prevToExclusive: string;

  if (spansMonths) {
    const pastActualUsd = sum(inRange(facts, period.from, `${month}-01`));
    let remaining = 0;
    for (let fm = addMonths(month, 1); `${fm}-01` < period.toExclusive; fm = addMonths(fm, 1)) remaining++;
    const future = futureMonths(m, remaining);
    const total = (pick: (p: FutureMonth) => number, reading: Reading) =>
      round2(pastActualUsd + currentMonthProjection(m, reading) + future.reduce((s, p) => s + pick(p), 0));
    projectedUsd = total((p) => p.projected, "point");
    lowUsd = total((p) => p.low, "low");
    highUsd = total((p) => p.high, "high");
    label = shortLabel(period.label);
    compareLabel = period.granularity === "quarter" ? "last quarter" : "last year";
    const span = period.granularity === "quarter" ? 3 : 12;
    prevToExclusive = period.from;
    prevFrom = `${addMonths(period.from.slice(0, 7), -span)}-01`;
  } else {
    projectedUsd = round2(currentMonthProjection(m));
    lowUsd = round2(currentMonthProjection(m, "low"));
    highUsd = round2(currentMonthProjection(m, "high"));
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

  return { label, compareLabel, projectedUsd, lowUsd, highUsd, prevPeriodUsd, deltaPct, basis };
}

/**
 * Dashed forward extension for month-granularity trend charts. The line is
 * ANCHORED on the current month at its ACTUAL MTD total — exactly the top of
 * the current month's bar — so it visibly continues from the last entry and
 * then moves to the projected months. Labels are chosen to MATCH the chart's
 * existing buckets so points land in the right slots instead of appending
 * duplicate categories:
 *  - year: current month + the year's remaining months ("Jul"…"Dec") — []
 *    when viewing a past year (nothing to project);
 *  - all: current month + 3 future months in the all-time style ("Jul 26").
 * Day/week granularities get no line ([]).
 */
export function projectTrendForPeriod(facts: ShapeFact[], now: Date, period: ProjectionPeriod, sourceHorizons?: Record<string, string>): TrendPoint[] {
  if (period.granularity !== "year" && period.granularity !== "all") return [];
  const m = monthModel(facts, now, sourceHorizons);
  if (!m) return [];
  if (period.granularity === "year" && period.from.slice(0, 4) !== m.month.slice(0, 4)) return []; // past year

  const label =
    period.granularity === "year"
      ? (ym: string) => SHORT[Number(ym.slice(5)) - 1]
      : (ym: string) => `${SHORT[Number(ym.slice(5)) - 1]} ${ym.slice(2, 4)}`;
  const horizon = period.granularity === "year" ? 12 - Number(m.month.slice(5)) : 3;
  const mtdTotal = m.levelUsd + m.sources.reduce((s, src) => s + src.mtdUsd, 0);
  return [
    // The current month's posted total = the height of its bar (no range —
    // it's an actual, not an estimate).
    { label: label(m.month), projected: round2(mtdTotal) },
    ...futureMonths(m, horizon).map((p) => ({
      label: label(p.month),
      projected: p.projected,
      ...(p.low !== p.high ? { projectedRange: [p.low, p.high] as [number, number] } : {}),
    })),
  ];
}

/**
 * Future monthly totals at the current pace and direction. Deliberately the
 * SAME producer as `projectPeriodEnd`'s future sum, so a quarter/year tile
 * equals the actual bars plus the dashed line's months — one story, not two.
 */
export function projectTrend(facts: ShapeFact[], now: Date, horizonMonths = 3, sourceHorizons?: Record<string, string>): FutureMonth[] {
  const m = monthModel(facts, now, sourceHorizons);
  if (!m) return [];
  return futureMonths(m, horizonMonths);
}
