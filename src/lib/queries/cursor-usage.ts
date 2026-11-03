import type { SupabaseClient } from "@supabase/supabase-js";
import type { CursorFactLite, CursorUsageDay, PersonCursorUsageScope, TeamCursorUsageScope } from "@/lib/cursor-usage/types";
import { earliestFactDay, fetchEmployeesAll } from "@/lib/queries/common";
import { personHref } from "@/lib/notify/digest";
import { aggregateTeamMonths } from "@/lib/cursor-usage/shape";

const PAGE = 1000;

/** Paginate (1000-row cap) with count-first fetching; `build` must order by a unique tiebreaker. */
async function fetchAll(
  label: string,
  build: (from: number, to: number, withCount: boolean) => PromiseLike<{ data: unknown[] | null; count: number | null; error: { message: string } | null }>,
): Promise<Record<string, unknown>[]> {
  const first = await build(0, PAGE - 1, true);
  if (first.error) throw new Error(`${label}: ${first.error.message}`);
  const out: Record<string, unknown>[] = [...((first.data as Record<string, unknown>[]) ?? [])];
  const total = first.count ?? out.length;
  if (total > PAGE) {
    const rest = await Promise.all(
      Array.from({ length: Math.ceil(total / PAGE) - 1 }, (_, i) => build((i + 1) * PAGE, (i + 2) * PAGE - 1, false)),
    );
    for (const p of rest) {
      if (p.error) throw new Error(`${label}: ${p.error.message}`);
      out.push(...((p.data as Record<string, unknown>[]) ?? []));
    }
  }
  return out;
}

const num = (v: unknown) => Number(v ?? 0);

const USAGE_COLUMNS =
  "day, entity_key, employee_id, is_active, agent_requests, subscription_included_reqs, usage_based_reqs, total_lines_added, total_lines_deleted, accepted_lines_added, accepted_lines_deleted, most_used_model";

const toUsageDay = (r: Record<string, unknown>): CursorUsageDay => ({
  day: r.day as string,
  employeeId: (r.employee_id as string | null) ?? null,
  entityKey: (r.entity_key as string) ?? "",
  isActive: Boolean(r.is_active),
  agentRequests: num(r.agent_requests),
  includedReqs: num(r.subscription_included_reqs),
  onDemandReqs: num(r.usage_based_reqs),
  linesAdded: num(r.total_lines_added),
  linesDeleted: num(r.total_lines_deleted),
  acceptedLinesAdded: num(r.accepted_lines_added),
  acceptedLinesDeleted: num(r.accepted_lines_deleted),
  mostUsedModel: (r.most_used_model as string | null) ?? null,
});
const toFactLite = (r: Record<string, unknown>): CursorFactLite => ({
  day: r.day as string,
  employeeId: (r.employee_id as string | null) ?? null,
  costType: r.cost_type as "seat" | "overage",
  costUsd: num(r.cost_usd),
});

/** A person's Cursor daily usage rows plus their Cursor seat/overage facts (admin-only view). */
export async function getPersonCursorUsageScope(supabase: SupabaseClient, employeeId: string): Promise<PersonCursorUsageScope> {
  const usageRaw = await fetchAll("getPersonCursorUsageScope(usage)", (from, to, withCount) =>
    supabase
      .from("cursor_daily_usage")
      .select(USAGE_COLUMNS, withCount ? { count: "exact" } : undefined)
      .eq("employee_id", employeeId)
      .order("day")
      .order("id")
      .range(from, to),
  );
  const factsRaw = await fetchAll("getPersonCursorUsageScope(facts)", (from, to, withCount) =>
    supabase
      .from("spend_facts")
      .select("day, employee_id, cost_type, cost_usd", withCount ? { count: "exact" } : undefined)
      .eq("source", "cursor")
      .eq("employee_id", employeeId)
      .in("cost_type", ["seat", "overage"])
      .order("day")
      .order("id")
      .range(from, to),
  );

  const rows = usageRaw.map(toUsageDay);
  const facts = factsRaw.map(toFactLite);
  const months = [...new Set(rows.map((r) => r.day.slice(0, 7)))].sort();
  return { rows, facts, months };
}

/**
 * Everyone's Cursor usage and Cursor seat/overage spend per (person, month), from the first month with
 * usage data (admin-only view). Reads every daily row and fact since then (~2k usage rows a month) but
 * returns only the per-person-month sums: the raw rows are ~0.6 MB a month and unstable_cache silently
 * skips entries over its size cap, so caching them would mean a full re-read on every Cursor page load.
 */
export async function getTeamCursorUsageScope(supabase: SupabaseClient): Promise<TeamCursorUsageScope> {
  const earliest = await earliestFactDay(supabase, "cursor_daily_usage");
  if (!earliest) return { months: [], people: [] };
  const from = `${earliest.slice(0, 7)}-01`;
  const [usageRaw, factsRaw, employees] = await Promise.all([
    fetchAll("getTeamCursorUsageScope(usage)", (lo, hi, withCount) =>
      supabase
        .from("cursor_daily_usage")
        .select(USAGE_COLUMNS, withCount ? { count: "exact" } : undefined)
        .gte("day", from)
        .order("day")
        .order("id")
        .range(lo, hi),
    ),
    fetchAll("getTeamCursorUsageScope(facts)", (lo, hi, withCount) =>
      supabase
        .from("spend_facts")
        .select("day, employee_id, cost_type, cost_usd", withCount ? { count: "exact" } : undefined)
        .eq("source", "cursor")
        .not("employee_id", "is", null)
        .in("cost_type", ["seat", "overage"])
        .gte("day", from)
        .order("day")
        .order("id")
        .range(lo, hi),
    ),
    fetchEmployeesAll(supabase, "id, full_name, department"),
  ]);
  const months = aggregateTeamMonths(usageRaw.map(toUsageDay), factsRaw.map(toFactLite));
  const wanted = new Set(months.flatMap((m) => (m.employeeId ? [m.employeeId] : [])));
  const people = employees
    .filter((e) => wanted.has(e.id as string))
    .map((e) => {
      const department = (e.department as string | null) ?? null;
      return { employeeId: e.id as string, name: (e.full_name as string) ?? "Unknown", department, href: personHref("", { id: e.id as string, department }) };
    });
  return { months, people };
}
