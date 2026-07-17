import type { Dim, ExploreData } from "./types";
import type { Period } from "./period";
import { packFacts, unpackFacts, type PackedFacts } from "./pack";
import { projectPeriodEnd, projectTrendForPeriod } from "./project";
import {
  trendForPeriod, treemapByDim, scorecardFor,
  rankTeams, rankPeople, rankTools, lineItems, rankAllStaff, type ShapeFact,
} from "./shape";

/**
 * Period-independent data fetched once on the server and handed to the client,
 * which re-derives the per-period views in-memory (no refetch on period change).
 */
export type RawScope =
  | { kind: "company"; title: string; earliest: string; facts: ShapeFact[]; headcounts: Record<string, number>; employees: { id: string; fullName: string | null; department: string | null }[]; toolColors: Record<string, string>; horizons: Record<string, string> }
  | { kind: "team"; title: string; earliest: string; facts: ShapeFact[]; team: string; employees: { id: string; fullName: string | null }[]; toolColors: Record<string, string>; horizons: Record<string, string> }
  | { kind: "person"; title: string; earliest: string; facts: ShapeFact[]; toolColors: Record<string, string>; horizons: Record<string, string> };

/**
 * The wire/cache form of a RawScope: facts packed into string tables + index
 * tuples (see pack.ts). ~70% smaller — fits the data-cache item cap and cuts
 * the RSC payload; the client unpacks once and shapes as usual.
 */
export type PackedScope = Omit<Extract<RawScope, { kind: "company" }>, "facts"> & { packed: PackedFacts }
  | Omit<Extract<RawScope, { kind: "team" }>, "facts"> & { packed: PackedFacts }
  | Omit<Extract<RawScope, { kind: "person" }>, "facts"> & { packed: PackedFacts };

/** Pack a scope for the cache/wire boundary. */
export function packScope(scope: RawScope): PackedScope {
  const { facts, ...rest } = scope;
  return { ...rest, packed: packFacts(facts) };
}

/** Restore a full RawScope client-side (memoize the call — unpacking 10k+ facts isn't free). */
export function unpackScope(scope: PackedScope): RawScope {
  const { packed, ...rest } = scope;
  return { ...rest, facts: unpackFacts(packed) } as RawScope;
}

const sumAll = (rows: ShapeFact[]) => Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 100) / 100;
const inPeriod = (p: Period) => (r: ShapeFact) => r.day >= p.from && r.day < p.toExclusive;
const bothDims = <T,>(fn: (d: Dim) => T): Record<Dim, T> => ({ vendor: fn("vendor"), cost_type: fn("cost_type") });

/** Pure: shape a scope into the per-period view. Runs client-side on every period change. */
export function buildExploreData(scope: RawScope, period: Period, now: Date = new Date()): ExploreData {
  const cur = scope.facts.filter(inPeriod(period));
  const base = {
    title: scope.title,
    period,
    earliest: scope.earliest,
    totalToDate: sumAll(scope.facts),
    scorecard: scorecardFor(cur),
    trend: bothDims((d) => trendForPeriod(scope.facts, period, d)),
    treemap: bothDims((d) => treemapByDim(cur, d, 12, scope.toolColors)),
    projection: { periodEnd: projectPeriodEnd(scope.facts, now, period, scope.horizons), trend: projectTrendForPeriod(scope.facts, now, period, scope.horizons) },
  };
  if (scope.kind === "company") {
    return {
      ...base,
      ranked: { kind: "team", rows: rankTeams(cur, new Map(Object.entries(scope.headcounts)), scope.toolColors) },
      allStaff: rankAllStaff(cur, scope.employees, scope.toolColors),
    };
  }
  if (scope.kind === "team") {
    return { ...base, ranked: { kind: "person", rows: rankPeople(cur, scope.team, scope.employees, scope.toolColors), tools: rankTools(cur, scope.toolColors) } };
  }
  return { ...base, ranked: { kind: "lineitem", rows: lineItems(cur) } };
}
