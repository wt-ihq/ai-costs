import type { SupabaseClient } from "@supabase/supabase-js";
import { lastNMonths } from "@/lib/rollup";
import { fetchFactsInRange, type EnrichedFact } from "./common";
import { UNATTRIBUTED, type ShapeFact } from "@/lib/explore/shape";
import type { RawScope } from "@/lib/explore/build";

const FETCH_MONTHS = 24; // fixed wide window — covers all data so the client can switch to any period
const asShape = (f: EnrichedFact): ShapeFact => f as unknown as ShapeFact;

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

/**
 * Fetch the full fact window ONCE (period-independent). The client re-slices it
 * per selected period, so this does not depend on which period is shown.
 * `earliest` = first month with data, used to cap back-stepping.
 */
async function fetchScope(supabase: SupabaseClient): Promise<{ rows: ShapeFact[]; earliest: string }> {
  const now = new Date();
  const from = lastNMonths(now, FETCH_MONTHS)[0] + "-01";
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));
  const rows = (await fetchFactsInRange(supabase, from, toExclusive)).map(asShape);
  const earliest = rows.length
    ? rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day).slice(0, 7)
    : now.toISOString().slice(0, 7);
  return { rows, earliest };
}

export async function getCompanyScope(supabase: SupabaseClient): Promise<RawScope> {
  const { rows, earliest } = await fetchScope(supabase);
  const { data: emps } = await supabase.from("employees").select("id, full_name, department");
  const employees = (emps ?? []).map((e) => ({ id: e.id as string, fullName: e.full_name as string | null, department: e.department as string | null }));
  const headcounts: Record<string, number> = {};
  for (const e of employees) {
    const d = e.department ?? UNATTRIBUTED;
    headcounts[d] = (headcounts[d] ?? 0) + 1;
  }
  return { kind: "company", title: "Company", earliest, facts: rows, headcounts, employees };
}

export async function getTeamScope(supabase: SupabaseClient, team: string): Promise<RawScope> {
  const { rows: all, earliest } = await fetchScope(supabase);
  const facts = all.filter((r) => (r.department ?? UNATTRIBUTED) === team);
  const { data: emps } = await supabase.from("employees").select("id, full_name").eq("department", team);
  const employees = (emps ?? []).map((e) => ({ id: e.id as string, fullName: e.full_name as string | null }));
  return { kind: "team", title: team, earliest, facts, team, employees };
}

export async function getPersonScope(supabase: SupabaseClient, employeeId: string): Promise<RawScope> {
  const { rows: all, earliest } = await fetchScope(supabase);
  const facts = all.filter((r) => r.employeeId === employeeId);
  const { data: emp } = await supabase.from("employees").select("full_name").eq("id", employeeId).single();
  return { kind: "person", title: (emp?.full_name as string) ?? "Unknown", earliest, facts };
}
