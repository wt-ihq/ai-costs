import type { SupabaseClient } from "@supabase/supabase-js";
import type { CostType, Vendor } from "@/lib/types";

/** A spend fact enriched with the employee's name + department. */
export interface EnrichedFact {
  day: string;
  source: Vendor;
  costType: CostType;
  costUsd: number;
  requests: number | null;
  entityKey: string;
  model: string;
  employeeId: string | null;
  fullName: string | null;
  department: string | null;
}

export interface MonthRange {
  month: string; // YYYY-MM
  from: string; // YYYY-MM-01
  toExclusive: string; // first day of next month
}

/**
 * Read employees paging past PostgREST's 1000-row cap (gotcha #1 — the table
 * only grows, since Okta leavers are retained). Optional department filter.
 */
export async function fetchEmployeesAll(
  supabase: SupabaseClient,
  columns: string,
  filter?: { department: string | null },
): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from("employees").select(columns);
    if (filter) q = filter.department === null ? q.is("department", null) : q.eq("department", filter.department);
    const { data, error } = await q.order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`fetchEmployeesAll: ${error.message}`);
    rows.push(...((data ?? []) as unknown as Record<string, unknown>[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

/**
 * First `day` on record in a fact table, or null when empty. Anchors the fetch
 * window at the actual start of the data — a fixed N-month lookback silently
 * excludes older spend from "All time" once the data outgrows it.
 */
export async function earliestFactDay(supabase: SupabaseClient, table = "spend_facts"): Promise<string | null> {
  const { data, error } = await supabase.from(table).select("day").order("day").limit(1);
  if (error) throw new Error(`earliestFactDay(${table}): ${error.message}`);
  return (data?.[0]?.day as string | undefined) ?? null;
}

export function monthRange(now: Date): MonthRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const first = (yy: number, mm: number) =>
    new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 10);
  return {
    month: now.toISOString().slice(0, 7),
    from: first(y, m),
    toExclusive: first(y, m + 1),
  };
}

/** Optional attribution filter, applied in SQL so scoped pages don't page the whole company's facts. */
export interface FactFilter {
  employeeIds: string[];
  /** Also include facts with no employee attribution (the "Unattributed" pseudo-team). */
  includeNullEmployee?: boolean;
  /** Also include person-less facts attributed to this department (recurring tool costs). */
  department?: string;
}

/** Fetch facts from `fromMonth` (YYYY-MM-01) up to `toExclusive` (YYYY-MM-01). */
export async function fetchFactsInRange(
  supabase: SupabaseClient,
  fromMonth: string,
  toExclusive: string,
  filter?: FactFilter,
): Promise<EnrichedFact[]> {
  if (filter && filter.employeeIds.length === 0 && !filter.includeNullEmployee && !filter.department) return [];
  // PostgREST caps each request at 1000 rows; a multi-month range now holds
  // thousands of facts (esp. Cursor per-event overage), so paginate until
  // exhausted — otherwise the dashboard silently undercounts spend. `day` has
  // thousands of ties, so order by the unique id as well — without the
  // tiebreaker a page boundary inside one day can duplicate or skip rows
  // (especially if the cron upserts mid-read).
  const PAGE = 1000;
  const data: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("spend_facts")
      .select("day, source, cost_type, cost_usd, requests, entity_key, model, employee_id, department, employees(full_name, department)")
      .gte("day", fromMonth)
      .lt("day", toExclusive);
    if (filter) {
      const ids = filter.employeeIds.join(",");
      if (filter.department) {
        // Team scope: employees' facts OR person-less facts pinned to the team.
        const deptEq = `department.eq."${filter.department.replace(/"/g, '')}"`;
        q = filter.employeeIds.length ? q.or(`employee_id.in.(${ids}),${deptEq}`) : q.or(deptEq);
      } else if (filter.includeNullEmployee) {
        // Unattributed scope: no employee AND no department attribution.
        q = filter.employeeIds.length
          ? q.or(`employee_id.in.(${ids}),and(employee_id.is.null,department.is.null)`)
          : q.is("employee_id", null).is("department", null);
      } else {
        q = q.in("employee_id", filter.employeeIds);
      }
    }
    const { data: page, error } = await q.order("day").order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`fetchFactsInRange: ${error.message}`);
    if (!page || page.length === 0) break;
    data.push(...(page as Record<string, unknown>[]));
    if (page.length < PAGE) break;
  }
  return data.map((r) => {
    const e = Array.isArray(r.employees) ? r.employees[0] : r.employees;
    const emp = e as { full_name: string | null; department: string | null } | undefined;
    return {
      day: r.day as string,
      source: r.source as EnrichedFact["source"],
      costType: r.cost_type as EnrichedFact["costType"],
      costUsd: Number(r.cost_usd),
      requests: r.requests == null ? null : Number(r.requests),
      entityKey: (r.entity_key as string) ?? "",
      model: (r.model as string) ?? "",
      employeeId: (r.employee_id as string | null) ?? null,
      fullName: emp?.full_name ?? null,
      department: (r.department as string | null) ?? emp?.department ?? null,
    };
  });
}
