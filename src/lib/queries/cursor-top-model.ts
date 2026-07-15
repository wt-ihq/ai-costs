import type { SupabaseClient } from "@supabase/supabase-js";
import { earliestFactDay } from "./common";

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
  const firstDay = await earliestFactDay(supabase, "cursor_top_model");
  const from = (firstDay ?? now.toISOString().slice(0, 10)).slice(0, 7) + "-01";
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));

  // Count-first pagination: the first page carries the exact total so the
  // rest fetch CONCURRENTLY instead of serially.
  const PAGE = 1000;
  const page = (withCount: boolean) =>
    supabase
      .from("cursor_top_model")
      .select("day, model, entity_key, employee_id, employees(full_name, department)", withCount ? { count: "exact" } : undefined)
      .gte("day", from)
      .lt("day", toExclusive)
      // id tiebreaker keeps page boundaries stable across queries.
      .order("day")
      .order("id");

  const { data: first, count, error } = await page(true).range(0, PAGE - 1);
  if (error) throw new Error(`getCursorTopModelScope: ${error.message}`);
  const raw: Record<string, unknown>[] = [...((first as Record<string, unknown>[]) ?? [])];
  const total = count ?? raw.length;
  if (total > PAGE) {
    const rest = await Promise.all(
      Array.from({ length: Math.ceil(total / PAGE) - 1 }, (_, i) => page(false).range((i + 1) * PAGE, (i + 2) * PAGE - 1)),
    );
    for (const p of rest) {
      if (p.error) throw new Error(`getCursorTopModelScope: ${p.error.message}`);
      raw.push(...((p.data as Record<string, unknown>[]) ?? []));
    }
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
