import type { SupabaseClient } from "@supabase/supabase-js";
import type { CostType, Vendor } from "@/lib/types";

/** A spend fact enriched with the employee's name + department. */
export interface EnrichedFact {
  source: Vendor;
  costType: CostType;
  costUsd: number;
  requests: number | null;
  employeeId: string | null;
  fullName: string | null;
  department: string | null;
}

export interface MonthRange {
  month: string; // YYYY-MM
  from: string; // YYYY-MM-01
  toExclusive: string; // first day of next month
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

/** PostgREST embeds a FK as object or single-element array — normalize it. */
function employeeOf(raw: unknown): { full_name: string | null; department: string | null } | undefined {
  const e = Array.isArray(raw) ? raw[0] : raw;
  return e as { full_name: string | null; department: string | null } | undefined;
}

/** Fetch one month of facts with the employee join, server-side (service role). */
export async function fetchMonthFacts(
  supabase: SupabaseClient,
  range: MonthRange,
): Promise<EnrichedFact[]> {
  const { data, error } = await supabase
    .from("spend_facts")
    .select("source, cost_type, cost_usd, requests, employee_id, employees(full_name, department)")
    .gte("day", range.from)
    .lt("day", range.toExclusive);
  if (error) throw new Error(`fetchMonthFacts: ${error.message}`);

  return (data ?? []).map((r) => {
    const emp = employeeOf(r.employees);
    return {
      source: r.source as Vendor,
      costType: r.cost_type as CostType,
      costUsd: Number(r.cost_usd),
      requests: r.requests == null ? null : Number(r.requests),
      employeeId: (r.employee_id as string | null) ?? null,
      fullName: emp?.full_name ?? null,
      department: emp?.department ?? null,
    };
  });
}
