import type { SupabaseClient } from "@supabase/supabase-js";
import { earliestFactDay, fetchEmployeesAll, fetchFactsInRange, type EnrichedFact, type FactFilter } from "./common";
import { UNATTRIBUTED, type ShapeFact } from "@/lib/explore/shape";
import type { RawScope } from "@/lib/explore/build";
import { OTHER_TOOL_PALETTE } from "@/lib/colors";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";

/**
 * source → its latest fact day, GLOBAL (not scope-filtered). The projection
 * needs each source's true data horizon: on a person/team page, that person's
 * last credit row may predate the import's coverage — the days between are
 * genuinely zero for them, not unknown.
 */
export async function getSourceHorizons(supabase: SupabaseClient): Promise<Record<string, string>> {
  const vendors = Object.keys(VENDOR_LABEL) as Vendor[];
  const out: Record<string, string> = {};
  await Promise.all(
    vendors.map(async (v) => {
      const { data, error } = await supabase
        .from("spend_facts")
        .select("day")
        .eq("source", v)
        .order("day", { ascending: false })
        .limit(1);
      if (error) throw new Error(`getSourceHorizons(${v}): ${error.message}`);
      if (data?.[0]?.day) out[v] = data[0].day as string;
    }),
  );
  return out;
}

const asShape = (f: EnrichedFact): ShapeFact => f as unknown as ShapeFact;

/** tool display name → stable hex, from recurring_costs color slots. */
export async function getToolColors(supabase: SupabaseClient): Promise<Record<string, string>> {
  // `.limit(1000)` is a bounded read over a table that grows by a handful of rows a year — acceptable.
  const { data, error } = await supabase.from("recurring_costs").select("tool, color_slot").limit(1000);
  if (error) throw new Error(`getToolColors: ${error.message}`);
  const out: Record<string, string> = {};
  for (const r of data ?? []) out[r.tool as string] = OTHER_TOOL_PALETTE[Number(r.color_slot) % OTHER_TOOL_PALETTE.length];
  return out;
}

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

/**
 * Fetch the scope's full fact window ONCE (period-independent). The client
 * re-slices it per selected period, so this does not depend on which period is
 * shown. The window starts at the first fact on record (a fixed N-month
 * lookback silently truncated "All time" once data outgrew it). `earliest` =
 * the scope's first month with data, used to cap back-stepping.
 */
async function fetchScope(
  supabase: SupabaseClient,
  filter?: FactFilter,
): Promise<{ rows: ShapeFact[]; earliest: string }> {
  const now = new Date();
  const firstDay = await earliestFactDay(supabase);
  const from = (firstDay ?? now.toISOString().slice(0, 10)).slice(0, 7) + "-01";
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));
  const rows = (await fetchFactsInRange(supabase, from, toExclusive, filter)).map(asShape);
  const earliest = rows.length
    ? rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day).slice(0, 7)
    : now.toISOString().slice(0, 7);
  return { rows, earliest };
}

export async function getCompanyScope(supabase: SupabaseClient): Promise<RawScope> {
  // Independent reads run concurrently — sequential awaits added whole
  // round-trips of latency per page view.
  const [{ rows, earliest }, emps, toolColors, horizons] = await Promise.all([
    fetchScope(supabase),
    fetchEmployeesAll(supabase, "id, full_name, department"),
    getToolColors(supabase),
    getSourceHorizons(supabase),
  ]);
  const employees = emps.map((e) => ({ id: e.id as string, fullName: e.full_name as string | null, department: e.department as string | null }));
  const headcounts: Record<string, number> = {};
  for (const e of employees) {
    const d = e.department ?? UNATTRIBUTED;
    headcounts[d] = (headcounts[d] ?? 0) + 1;
  }
  return { kind: "company", title: "Company", earliest, facts: rows, headcounts, employees, toolColors, horizons };
}

export async function getTeamScope(supabase: SupabaseClient, team: string): Promise<RawScope> {
  // Resolve the team's members first so the fact read can filter in SQL
  // (fetching the whole company's window to keep ~one team's rows was many
  // needless 1000-row round trips). The "Unattributed" pseudo-team is
  // employees with no department PLUS facts with no employee at all.
  const isUnattributed = team === UNATTRIBUTED;
  const emps = await fetchEmployeesAll(supabase, "id, full_name", { department: isUnattributed ? null : team });
  const employees = emps.map((e) => ({ id: e.id as string, fullName: e.full_name as string | null }));
  const [{ rows: facts, earliest }, toolColors, horizons] = await Promise.all([
    fetchScope(supabase, {
      employeeIds: employees.map((e) => e.id),
      includeNullEmployee: isUnattributed,
      department: isUnattributed ? undefined : team,
    }),
    getToolColors(supabase),
    getSourceHorizons(supabase),
  ]);
  return { kind: "team", title: team, earliest, facts, team, employees, toolColors, horizons };
}

export interface SearchItem {
  kind: "team" | "person";
  label: string;
  sub?: string;
  href: string;
}

/**
 * Flat index of every team (department) and person, for the autocomplete search.
 * Hrefs mirror the drill-down routes the ranked lists build in `shape.ts`.
 */
export async function getSearchIndex(supabase: SupabaseClient): Promise<SearchItem[]> {
  const emps = await fetchEmployeesAll(supabase, "id, full_name, department");
  const employees = emps.map((e) => ({
    id: e.id as string,
    fullName: (e.full_name as string | null) ?? "Unknown",
    department: (e.department as string | null) ?? UNATTRIBUTED,
  }));

  const teams = [...new Set(employees.map((e) => e.department))].sort((a, b) => a.localeCompare(b));
  const teamItems: SearchItem[] = teams.map((dept) => ({
    kind: "team",
    label: dept,
    sub: "Team",
    href: `/explore/${encodeURIComponent(dept)}`,
  }));

  const peopleItems: SearchItem[] = [...employees]
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((e) => ({
      kind: "person",
      label: e.fullName,
      sub: e.department,
      href: `/explore/${encodeURIComponent(e.department)}/${e.id}`,
    }));

  return [...teamItems, ...peopleItems];
}

export async function getPersonScope(supabase: SupabaseClient, employeeId: string): Promise<RawScope> {
  const [{ rows: facts, earliest }, { data: emp }, toolColors, horizons] = await Promise.all([
    fetchScope(supabase, { employeeIds: [employeeId] }),
    supabase.from("employees").select("full_name").eq("id", employeeId).single(),
    getToolColors(supabase),
    getSourceHorizons(supabase),
  ]);
  return { kind: "person", title: (emp?.full_name as string) ?? "Unknown", earliest, facts, toolColors, horizons };
}
