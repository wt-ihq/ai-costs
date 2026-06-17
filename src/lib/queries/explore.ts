import type { SupabaseClient } from "@supabase/supabase-js";
import { lastNMonths } from "@/lib/rollup";
import { fetchFactsInRange, type EnrichedFact } from "./common";
import {
  trendForPeriod, treemapByDim, scorecardFor,
  rankTeams, rankPeople, lineItems, UNATTRIBUTED, type ShapeFact,
} from "@/lib/explore/shape";
import type { Dim, ExploreData } from "@/lib/explore/types";
import type { Period } from "@/lib/explore/period";

const FETCH_MONTHS = 24; // baseline lookback for "total to date"
const asShape = (f: EnrichedFact): ShapeFact => f as unknown as ShapeFact;
const sumAll = (rows: ShapeFact[]) => Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 100) / 100;
const inPeriod = (p: Period) => (r: ShapeFact) => r.day >= p.from && r.day < p.toExclusive;

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7) + "-01";
}

/** Fetch all facts needed: max(24-month lookback, the selected period) → current month. */
async function fetchScope(supabase: SupabaseClient, period: Period) {
  const now = new Date();
  const baseFrom = lastNMonths(now, FETCH_MONTHS)[0] + "-01";
  const from = period.from < baseFrom ? period.from : baseFrom;
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));
  const rows = (await fetchFactsInRange(supabase, from, toExclusive)).map(asShape);
  const earliest = rows.length
    ? rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day).slice(0, 7)
    : now.toISOString().slice(0, 7);
  return { rows, earliest };
}

async function headcounts(supabase: SupabaseClient): Promise<Map<string, number>> {
  const { data } = await supabase.from("employees").select("department");
  const m = new Map<string, number>();
  for (const e of data ?? []) {
    const d = (e.department as string | null) ?? UNATTRIBUTED;
    m.set(d, (m.get(d) ?? 0) + 1);
  }
  return m;
}

function bothDims<T>(fn: (dim: Dim) => T): Record<Dim, T> {
  return { vendor: fn("vendor"), cost_type: fn("cost_type") };
}

function assemble(
  rows: ShapeFact[],
  cur: ShapeFact[],
  period: Period,
  base: { title: string; earliest: string; ranked: ExploreData["ranked"] },
): ExploreData {
  return {
    title: base.title,
    period,
    earliest: base.earliest,
    totalToDate: sumAll(rows),
    scorecard: scorecardFor(cur),
    trend: bothDims((d) => trendForPeriod(rows, period, d)),
    treemap: bothDims((d) => treemapByDim(cur, d)),
    ranked: base.ranked,
  };
}

export async function getCompanyExplore(supabase: SupabaseClient, period: Period): Promise<ExploreData> {
  const { rows, earliest } = await fetchScope(supabase, period);
  const cur = rows.filter(inPeriod(period));
  return assemble(rows, cur, period, { title: "Company", earliest, ranked: { kind: "team", rows: rankTeams(cur, await headcounts(supabase)) } });
}

export async function getTeamExplore(supabase: SupabaseClient, team: string, period: Period): Promise<ExploreData> {
  const { rows: all, earliest } = await fetchScope(supabase, period);
  const rows = all.filter((r) => (r.department ?? UNATTRIBUTED) === team);
  const cur = rows.filter(inPeriod(period));
  const { data: emps } = await supabase.from("employees").select("id, full_name, department").eq("department", team);
  const employees = (emps ?? []).map((e) => ({ id: e.id as string, fullName: e.full_name as string | null }));
  return assemble(rows, cur, period, { title: team, earliest, ranked: { kind: "person", rows: rankPeople(cur, team, employees) } });
}

export async function getPersonExplore(supabase: SupabaseClient, _team: string, employeeId: string, period: Period): Promise<ExploreData> {
  const { rows: all, earliest } = await fetchScope(supabase, period);
  const rows = all.filter((r) => r.employeeId === employeeId);
  const cur = rows.filter(inPeriod(period));
  const { data: emp } = await supabase.from("employees").select("full_name").eq("id", employeeId).single();
  return assemble(rows, cur, period, { title: (emp?.full_name as string) ?? "Unknown", earliest, ranked: { kind: "lineitem", rows: lineItems(cur) } });
}
