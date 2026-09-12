import type { RawScope } from "./build";
import { stepPeriod, type Period } from "./period";
import { isMonthlyLevelFact, rankPeople, rankTeams, rankTools, lineItems, type ShapeFact } from "./shape";
import type { RankRow } from "./types";

/** One entity's spend in the current period against the previous one. */
export interface TrendMover {
  id: string;
  label: string;
  href?: string;
  current: number;
  prior: number;
  delta: number;
  /** Percent change; null when there was no prior spend to compare against. */
  pct: number | null;
}

/** A day whose variable spend stands well above the period's typical day. */
export interface NotableDay {
  day: string;
  total: number;
  median: number;
  /** Label of the entity (team/person/line item) that contributed most that day. */
  driver: string | null;
}

export interface TrendsData {
  /** Label of the period compared against, e.g. "August 2026". */
  priorLabel: string;
  /**
   * When the current period is still in progress, both sides are cut to this
   * many elapsed days (today excluded — its facts haven't landed) and
   * monthly-level facts are dropped from both. Null for a complete period.
   */
  truncatedDays: number | null;
  current: number;
  prior: number;
  delta: number;
  pct: number | null;
  risers: TrendMover[];
  fallers: TrendMover[];
  newSpenders: TrendMover[];
  goneQuiet: TrendMover[];
  notableDays: NotableDay[];
  /** Person-level Anthropic spend is an estimated allocation of an exact daily total. */
  hasEstimatedAllocation: boolean;
}

/** Rows where neither side reaches this are noise, not a trend. */
const MOVER_FLOOR_USD = 1;
const TOP_N = 5;
/** A day counts as notable at this multiple of the period's median non-zero day… */
const NOTABLE_MULTIPLE = 2;
/** …provided it also clears an absolute floor, so quiet periods don't flag a $3 day. */
const NOTABLE_FLOOR_USD = 5;
/** Fewer non-zero days than this and a median says nothing. */
const NOTABLE_MIN_DAYS = 5;

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const shiftDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const inWindow = (from: string, toExclusive: string) => (r: ShapeFact) => r.day >= from && r.day < toExclusive;
const sum = (rows: ShapeFact[]) => rows.reduce((s, r) => s + r.costUsd, 0);
const isVariable = (r: ShapeFact) => r.costType === "metered" || r.costType === "overage";

/** The same grouping the page's ranked list uses, so movers link and label identically. */
function rankAtGrain(scope: RawScope, rows: ShapeFact[]): RankRow[] {
  if (scope.kind === "company") return rankTeams(rows, new Map(Object.entries(scope.headcounts)), scope.toolColors);
  if (scope.kind === "team") return [...rankPeople(rows, scope.team, scope.employees, scope.toolColors), ...rankTools(rows, scope.toolColors)];
  return lineItems(rows, scope.toolColors);
}

function pctChange(prior: number, current: number): number | null {
  if (prior === 0) return null;
  return round2(((current - prior) / prior) * 100);
}

function movers(scope: RawScope, cur: ShapeFact[], prev: ShapeFact[]): Pick<TrendsData, "risers" | "fallers" | "newSpenders" | "goneQuiet"> {
  const curRows = new Map(rankAtGrain(scope, cur).map((r) => [r.id, r]));
  const prevRows = new Map(rankAtGrain(scope, prev).map((r) => [r.id, r]));
  const all: TrendMover[] = [];
  for (const id of new Set([...curRows.keys(), ...prevRows.keys()])) {
    const c = curRows.get(id);
    const p = prevRows.get(id);
    const current = c?.total ?? 0;
    const prior = p?.total ?? 0;
    if (Math.max(current, prior) < MOVER_FLOOR_USD) continue;
    const row = (c ?? p)!;
    all.push({ id, label: row.label, href: row.href, current, prior, delta: round2(current - prior), pct: pctChange(prior, current) });
  }
  const byAbsDelta = (a: TrendMover, b: TrendMover) => Math.abs(b.delta) - Math.abs(a.delta);
  const both = all.filter((m) => m.current > 0 && m.prior > 0);
  return {
    risers: both.filter((m) => m.delta > 0).sort(byAbsDelta).slice(0, TOP_N),
    fallers: both.filter((m) => m.delta < 0).sort(byAbsDelta).slice(0, TOP_N),
    newSpenders: all.filter((m) => m.prior === 0 && m.current > 0).sort(byAbsDelta),
    goneQuiet: all.filter((m) => m.current === 0 && m.prior > 0).sort(byAbsDelta),
  };
}

function notableDays(scope: RawScope, cur: ShapeFact[]): NotableDay[] {
  const byDay = new Map<string, ShapeFact[]>();
  for (const r of cur) {
    if (!isVariable(r) || r.costUsd <= 0) continue;
    const list = byDay.get(r.day);
    if (list) list.push(r);
    else byDay.set(r.day, [r]);
  }
  const totals = [...byDay.entries()].map(([day, rows]) => ({ day, rows, total: sum(rows) })).filter((d) => d.total > 0);
  if (totals.length < NOTABLE_MIN_DAYS) return [];
  const sorted = totals.map((d) => d.total).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return totals
    .filter((d) => d.total >= NOTABLE_FLOOR_USD && d.total > median * NOTABLE_MULTIPLE)
    .sort((a, b) => b.total - a.total)
    .map((d) => ({ day: d.day, total: round2(d.total), median: round2(median), driver: rankAtGrain(scope, d.rows)[0]?.label ?? null }));
}

/**
 * Pure: how this period moved against the previous one, at the page's grain.
 * Uses the scope's in-memory facts (the previous period is already there —
 * no refetch). Null on "All time", which has nothing to compare against.
 */
export function buildTrends(scope: RawScope, period: Period, now: Date = new Date()): TrendsData | null {
  if (period.granularity === "all") return null;
  const prior = stepPeriod(period, -1, now);
  const today = now.toISOString().slice(0, 10);

  // An in-progress month against a full previous month always reads as a
  // drop, so compare the same number of elapsed days on each side.
  const inProgress = period.granularity !== "day" && today < period.toExclusive;
  let truncatedDays: number | null = null;
  let cur: ShapeFact[];
  let prev: ShapeFact[];
  if (inProgress) {
    truncatedDays = daysBetween(period.from, today);
    if (truncatedDays <= 0) return null;
    const daily = scope.facts.filter((r) => !isMonthlyLevelFact(r));
    cur = daily.filter(inWindow(period.from, shiftDays(period.from, truncatedDays)));
    prev = daily.filter(inWindow(prior.from, shiftDays(prior.from, truncatedDays)));
  } else {
    cur = scope.facts.filter(inWindow(period.from, period.toExclusive));
    prev = scope.facts.filter(inWindow(prior.from, prior.toExclusive));
  }

  const current = round2(sum(cur));
  const priorTotal = round2(sum(prev));
  const coarse = period.granularity === "month" || period.granularity === "quarter" || period.granularity === "year";
  return {
    priorLabel: prior.label,
    truncatedDays,
    current,
    prior: priorTotal,
    delta: round2(current - priorTotal),
    pct: pctChange(priorTotal, current),
    ...movers(scope, cur, prev),
    notableDays: coarse ? notableDays(scope, cur) : [],
    hasEstimatedAllocation: scope.kind !== "company" && [...cur, ...prev].some((r) => r.source === "anthropic" && !!r.employeeId),
  };
}
