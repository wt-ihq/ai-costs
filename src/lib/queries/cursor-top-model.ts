import type { SupabaseClient } from "@supabase/supabase-js";
import { lastNMonths } from "@/lib/rollup";

const FETCH_MONTHS = 24;

/** One per-user/day most-used-model row, enriched with employee name + dept. */
export interface TopModelRow {
  day: string;
  model: string;
  entityKey: string;
  employeeId: string | null;
  fullName: string | null;
  department: string | null;
}

export interface TopModelScope {
  rows: TopModelRow[];
  earliest: string;
}

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

/** Fetch the full Teams-plan top-model window once; the client slices by period. */
export async function getCursorTopModelScope(supabase: SupabaseClient): Promise<TopModelScope> {
  const now = new Date();
  const from = lastNMonths(now, FETCH_MONTHS)[0] + "-01";
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));

  const PAGE = 1000;
  const raw: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("cursor_top_model")
      .select("day, model, entity_key, employee_id, employees(full_name, department)")
      .gte("day", from)
      .lt("day", toExclusive)
      .order("day")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`getCursorTopModelScope: ${error.message}`);
    if (!data || data.length === 0) break;
    raw.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) break;
  }

  const rows: TopModelRow[] = raw.map((r) => {
    const e = Array.isArray(r.employees) ? r.employees[0] : r.employees;
    const emp = e as { full_name: string | null; department: string | null } | undefined;
    return {
      day: r.day as string,
      model: (r.model as string) ?? "",
      entityKey: (r.entity_key as string) ?? "",
      employeeId: (r.employee_id as string | null) ?? null,
      fullName: emp?.full_name ?? null,
      department: emp?.department ?? null,
    };
  });

  const earliest = rows.length
    ? rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day).slice(0, 7)
    : now.toISOString().slice(0, 7);
  return { rows, earliest };
}
