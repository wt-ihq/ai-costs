import type { SupabaseClient } from "@supabase/supabase-js";
import { lastNMonths } from "@/lib/rollup";
import { fetchFactsInRange, type EnrichedFact } from "./common";
import {
  trendByDim, dailyByDim, treemapByDim, seriesKeys, scorecardFor,
  rankTeams, rankPeople, lineItems, UNATTRIBUTED, type ShapeFact,
} from "@/lib/explore/shape";
import type { Dim, ExploreData } from "@/lib/explore/types";

const MONTHS = 12;
const asShape = (f: EnrichedFact): ShapeFact => f as unknown as ShapeFact;

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7) + "-01";
}
function prevMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
}
function range(month: string) {
  const months = lastNMonths(new Date(`${month}-15T00:00:00Z`), MONTHS);
  return { months, from: months[0] + "-01", toExclusive: nextMonth(months[months.length - 1]) };
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

export async function getCompanyExplore(supabase: SupabaseClient, month: string): Promise<ExploreData> {
  const { months, from, toExclusive } = range(month);
  const rows = (await fetchFactsInRange(supabase, from, toExclusive)).map(asShape);
  const cur = rows.filter((r) => r.day.slice(0, 7) === month);
  return {
    title: "Company",
    month,
    scorecard: scorecardFor(rows, month, prevMonth(month)),
    trend: bothDims((d) => trendByDim(rows, months, d)),
    treemap: bothDims((d) => treemapByDim(cur, d)),
    series: bothDims((d) => seriesKeys(cur, d)),
    ranked: { kind: "team", rows: rankTeams(cur, await headcounts(supabase)) },
  };
}

export async function getTeamExplore(supabase: SupabaseClient, team: string, month: string): Promise<ExploreData> {
  const { months, from, toExclusive } = range(month);
  const all = (await fetchFactsInRange(supabase, from, toExclusive)).map(asShape);
  const rows = all.filter((r) => (r.department ?? UNATTRIBUTED) === team);
  const cur = rows.filter((r) => r.day.slice(0, 7) === month);
  const { data: emps } = await supabase.from("employees").select("id, full_name, department").eq("department", team);
  const employees = (emps ?? []).map((e) => ({ id: e.id as string, fullName: e.full_name as string | null }));
  return {
    title: team,
    month,
    scorecard: scorecardFor(rows, month, prevMonth(month)),
    trend: bothDims((d) => trendByDim(rows, months, d)),
    treemap: bothDims((d) => treemapByDim(cur, d)),
    series: bothDims((d) => seriesKeys(cur, d)),
    ranked: { kind: "person", rows: rankPeople(cur, team, employees) },
  };
}

export async function getPersonExplore(supabase: SupabaseClient, _team: string, employeeId: string, month: string): Promise<ExploreData> {
  const { months, from, toExclusive } = range(month);
  const all = (await fetchFactsInRange(supabase, from, toExclusive)).map(asShape);
  const rows = all.filter((r) => r.employeeId === employeeId);
  const cur = rows.filter((r) => r.day.slice(0, 7) === month);
  const { data: emp } = await supabase.from("employees").select("full_name").eq("id", employeeId).single();
  return {
    title: (emp?.full_name as string) ?? "Unknown",
    month,
    scorecard: scorecardFor(rows, month, prevMonth(month)),
    trend: bothDims((d) => trendByDim(rows, months, d)),
    treemap: bothDims((d) => treemapByDim(cur, d)),
    series: bothDims((d) => seriesKeys(cur, d)),
    ranked: { kind: "lineitem", rows: lineItems(cur) },
    daily: bothDims((d) => dailyByDim(rows, month, d)),
  };
}
