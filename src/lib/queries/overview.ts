import type { SupabaseClient } from "@supabase/supabase-js";
import {
  byCostType,
  byDepartment,
  bySource,
  lastNMonths,
  monthlyByVendor,
  total,
  type RollupRow,
} from "@/lib/rollup";

export interface OverviewData {
  months: string[];
  currentMonth: string;
  currentTotal: number;
  prevTotal: number;
  costSplit: ReturnType<typeof byCostType>;
  bySource: ReturnType<typeof bySource>;
  byDepartment: ReturnType<typeof byDepartment>;
  trend: ReturnType<typeof monthlyByVendor>;
}

/**
 * Read 12 months of facts (server-side, service-role) and derive everything
 * the Overview page needs. Aggregation is done in TS via pure rollup helpers —
 * fine at v1 scale (low hundreds of seats); push to SQL views later if needed.
 */
export async function getOverviewData(
  supabase: SupabaseClient,
  now: Date,
): Promise<OverviewData> {
  const months = lastNMonths(now, 12);
  const from = months[0] + "-01";

  const { data, error } = await supabase
    .from("spend_facts")
    .select("day, source, cost_type, cost_usd, employees(department)")
    .gte("day", from);
  if (error) throw new Error(`getOverviewData: ${error.message}`);

  const rows: RollupRow[] = (data ?? []).map((r) => {
    // Embedded FK comes back as an object or a single-element array depending
    // on PostgREST inference (no generated DB types here) — handle both.
    const empRaw = r.employees as unknown;
    const emp = (Array.isArray(empRaw) ? empRaw[0] : empRaw) as
      | { department: string | null }
      | undefined;
    return {
      day: r.day as string,
      source: r.source as RollupRow["source"],
      costType: r.cost_type as RollupRow["costType"],
      costUsd: Number(r.cost_usd),
      department: emp?.department ?? null,
    };
  });

  const currentMonth = months[months.length - 1];
  const prevMonth = months[months.length - 2];
  const inMonth = (m: string) => rows.filter((r) => r.day.slice(0, 7) === m);
  const current = inMonth(currentMonth);

  return {
    months,
    currentMonth,
    currentTotal: total(current),
    prevTotal: total(inMonth(prevMonth)),
    costSplit: byCostType(current),
    bySource: bySource(current),
    byDepartment: byDepartment(current),
    trend: monthlyByVendor(rows, months),
  };
}
