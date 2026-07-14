import type { Dim, ExploreData } from "./types";
import type { Period } from "./period";
import {
  trendForPeriod, treemapByDim, scorecardFor,
  rankTeams, rankPeople, lineItems, rankAllStaff, type ShapeFact,
} from "./shape";

/**
 * Period-independent data fetched once on the server and handed to the client,
 * which re-derives the per-period views in-memory (no refetch on period change).
 */
export type RawScope =
  | { kind: "company"; title: string; earliest: string; facts: ShapeFact[]; headcounts: Record<string, number>; employees: { id: string; fullName: string | null; department: string | null }[]; toolColors: Record<string, string> }
  | { kind: "team"; title: string; earliest: string; facts: ShapeFact[]; team: string; employees: { id: string; fullName: string | null }[]; toolColors: Record<string, string> }
  | { kind: "person"; title: string; earliest: string; facts: ShapeFact[]; toolColors: Record<string, string> };

const sumAll = (rows: ShapeFact[]) => Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 100) / 100;
const inPeriod = (p: Period) => (r: ShapeFact) => r.day >= p.from && r.day < p.toExclusive;
const bothDims = <T,>(fn: (d: Dim) => T): Record<Dim, T> => ({ vendor: fn("vendor"), cost_type: fn("cost_type") });

/** Pure: shape a scope into the per-period view. Runs client-side on every period change. */
export function buildExploreData(scope: RawScope, period: Period): ExploreData {
  const cur = scope.facts.filter(inPeriod(period));
  const base = {
    title: scope.title,
    period,
    earliest: scope.earliest,
    totalToDate: sumAll(scope.facts),
    scorecard: scorecardFor(cur),
    trend: bothDims((d) => trendForPeriod(scope.facts, period, d)),
    treemap: bothDims((d) => treemapByDim(cur, d)),
  };
  if (scope.kind === "company") {
    return { ...base, ranked: { kind: "team", rows: rankTeams(cur, new Map(Object.entries(scope.headcounts))) }, allStaff: rankAllStaff(cur, scope.employees) };
  }
  if (scope.kind === "team") {
    return { ...base, ranked: { kind: "person", rows: rankPeople(cur, scope.team, scope.employees) } };
  }
  return { ...base, ranked: { kind: "lineitem", rows: lineItems(cur) } };
}
