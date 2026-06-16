import type { SupabaseClient } from "@supabase/supabase-js";
import { lastNMonths } from "@/lib/rollup";
import { fetchFactsInRange, type EnrichedFact } from "./common";
import {
  trendByDim, dailyByDim, treemapByDim, seriesKeys, scorecardFor,
  rankTeams, rankPeople, lineItems, UNATTRIBUTED, type ShapeFact,
} from "@/lib/explore/shape";
import type { Dim, ExploreData } from "@/lib/explore/types";

const FETCH_MONTHS = 24; // wide enough to cover all history -> "total to date"
const TREND_MONTHS = 12; // rolling window shown in the trend chart
const asShape = (f: EnrichedFact): ShapeFact => f as unknown as ShapeFact;
const sumAll = (rows: ShapeFact[]) => Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 100) / 100;

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7) + "-01";
}
function prevMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
}

/** Fetch all facts to date (24-month lookback) + the trend window (last 12). */
async function fetchScope(supabase: SupabaseClient) {
  const now = new Date();
  const fetchMonths = lastNMonths(now, FETCH_MONTHS);
  const from = fetchMonths[0] + "-01";
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));
  const rows = (await fetchFactsInRange(supabase, from, toExclusive)).map(asShape);
  return { rows, trendMonths: lastNMonths(now, TREND_MONTHS) };
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

/** Shared assembly: trend (all rows), month-scoped breakdowns, totals. */
function assemble(rows: ShapeFact[], trendMonths: string[], month: string, base: Pick<ExploreData, "title" | "ranked"> & { daily?: boolean }): ExploreData {
  const cur = rows.filter((r) => r.day.slice(0, 7) === month);
  return {
    title: base.title,
    month,
    totalToDate: sumAll(rows),
    scorecard: scorecardFor(rows, month, prevMonth(month)),
    trend: bothDims((d) => trendByDim(rows, trendMonths, d)),
    treemap: bothDims((d) => treemapByDim(cur, d)),
    series: bothDims((d) => seriesKeys(cur, d)),
    ranked: base.ranked,
    ...(base.daily ? { daily: bothDims((d) => dailyByDim(rows, month, d)) } : {}),
  };
}

export async function getCompanyExplore(supabase: SupabaseClient, month: string): Promise<ExploreData> {
  const { rows, trendMonths } = await fetchScope(supabase);
  const cur = rows.filter((r) => r.day.slice(0, 7) === month);
  return assemble(rows, trendMonths, month, { title: "Company", ranked: { kind: "team", rows: rankTeams(cur, await headcounts(supabase)) } });
}

export async function getTeamExplore(supabase: SupabaseClient, team: string, month: string): Promise<ExploreData> {
  const { rows: all, trendMonths } = await fetchScope(supabase);
  const rows = all.filter((r) => (r.department ?? UNATTRIBUTED) === team);
  const cur = rows.filter((r) => r.day.slice(0, 7) === month);
  const { data: emps } = await supabase.from("employees").select("id, full_name, department").eq("department", team);
  const employees = (emps ?? []).map((e) => ({ id: e.id as string, fullName: e.full_name as string | null }));
  return assemble(rows, trendMonths, month, { title: team, ranked: { kind: "person", rows: rankPeople(cur, team, employees) } });
}

export async function getPersonExplore(supabase: SupabaseClient, _team: string, employeeId: string, month: string): Promise<ExploreData> {
  const { rows: all, trendMonths } = await fetchScope(supabase);
  const rows = all.filter((r) => r.employeeId === employeeId);
  const cur = rows.filter((r) => r.day.slice(0, 7) === month);
  const { data: emp } = await supabase.from("employees").select("full_name").eq("id", employeeId).single();
  return assemble(rows, trendMonths, month, { title: (emp?.full_name as string) ?? "Unknown", daily: true, ranked: { kind: "lineitem", rows: lineItems(cur) } });
}
