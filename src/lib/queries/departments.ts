import type { SupabaseClient } from "@supabase/supabase-js";
import type { Vendor } from "@/lib/types";
import { UNATTRIBUTED } from "@/lib/rollup";
import { fetchMonthFacts, monthRange, type EnrichedFact } from "./common";

export interface DepartmentRow {
  department: string;
  perVendor: Partial<Record<Vendor, number>>;
  total: number;
  headcount: number;
  perHead: number | null; // null when headcount unknown (e.g. Unattributed)
}

export interface DepartmentsData {
  month: string;
  vendors: Vendor[];
  rows: DepartmentRow[];
}

/** Pure: build the dept × vendor matrix with totals and per-head spend. */
export function buildDepartmentRows(
  facts: EnrichedFact[],
  headcounts: Map<string, number>,
): { vendors: Vendor[]; rows: DepartmentRow[] } {
  const vendors = [...new Set(facts.map((f) => f.source))].sort() as Vendor[];
  const byDept = new Map<string, DepartmentRow>();

  for (const f of facts) {
    const dept = f.department ?? UNATTRIBUTED;
    const row =
      byDept.get(dept) ??
      ({ department: dept, perVendor: {}, total: 0, headcount: headcounts.get(dept) ?? 0, perHead: null } as DepartmentRow);
    row.perVendor[f.source] = (row.perVendor[f.source] ?? 0) + f.costUsd;
    row.total += f.costUsd;
    byDept.set(dept, row);
  }

  const rows = [...byDept.values()]
    .map((r) => ({
      ...r,
      perHead: r.department === UNATTRIBUTED || r.headcount === 0 ? null : r.total / r.headcount,
    }))
    .sort((a, b) => b.total - a.total);

  return { vendors, rows };
}

export async function getDepartmentsData(
  supabase: SupabaseClient,
  now: Date,
): Promise<DepartmentsData> {
  const range = monthRange(now);
  const facts = await fetchMonthFacts(supabase, range);

  const { data: emps, error } = await supabase.from("employees").select("department");
  if (error) throw new Error(`getDepartmentsData: ${error.message}`);
  const headcounts = new Map<string, number>();
  for (const e of emps ?? []) {
    const d = (e.department as string | null) ?? UNATTRIBUTED;
    headcounts.set(d, (headcounts.get(d) ?? 0) + 1);
  }

  return { month: range.month, ...buildDepartmentRows(facts, headcounts) };
}
