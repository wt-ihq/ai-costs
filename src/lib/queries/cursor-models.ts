import type { SupabaseClient } from "@supabase/supabase-js";
import { earliestFactDay } from "./common";

/** One row of Cursor model usage, enriched with employee name + department. */
export interface ModelUsageRow {
  day: string;
  model: string;
  messages: number;
  employeeId: string | null;
  fullName: string | null;
  department: string | null;
}

export interface ModelUsageScope {
  rows: ModelUsageRow[];
  earliest: string; // first month with data (YYYY-MM), caps back-stepping
}

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

/**
 * Fetch the full Cursor model-usage window ONCE (period-independent); the client
 * re-slices per selected period. Paginates the 1000-row PostgREST cap — a
 * 24-month range of per-(day,user,model) rows easily exceeds it, and a missed
 * page would silently undercount adoption.
 */
export async function getModelUsageScope(supabase: SupabaseClient): Promise<ModelUsageScope> {
  const now = new Date();
  const firstDay = await earliestFactDay(supabase, "cursor_model_usage");
  const from = (firstDay ?? now.toISOString().slice(0, 10)).slice(0, 7) + "-01";
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));

  // Count-first pagination: the first page carries the exact total so the
  // rest fetch CONCURRENTLY (sequential round-trips made this page slow).
  const PAGE = 1000;
  const page = (withCount: boolean) =>
    supabase
      .from("cursor_model_usage")
      .select("day, model, messages, employee_id, employees(full_name, department)", withCount ? { count: "exact" } : undefined)
      .gte("day", from)
      .lt("day", toExclusive)
      // id tiebreaker keeps page boundaries stable across queries.
      .order("day")
      .order("id");

  const { data: first, count, error } = await page(true).range(0, PAGE - 1);
  if (error) throw new Error(`getModelUsageScope: ${error.message}`);
  const raw: Record<string, unknown>[] = [...((first as Record<string, unknown>[]) ?? [])];
  const total = count ?? raw.length;
  if (total > PAGE) {
    const rest = await Promise.all(
      Array.from({ length: Math.ceil(total / PAGE) - 1 }, (_, i) => page(false).range((i + 1) * PAGE, (i + 2) * PAGE - 1)),
    );
    for (const p of rest) {
      if (p.error) throw new Error(`getModelUsageScope: ${p.error.message}`);
      raw.push(...((p.data as Record<string, unknown>[]) ?? []));
    }
  }

  const rows: ModelUsageRow[] = raw.map((r) => {
    const e = Array.isArray(r.employees) ? r.employees[0] : r.employees;
    const emp = e as { full_name: string | null; department: string | null } | undefined;
    return {
      day: r.day as string,
      model: (r.model as string) ?? "",
      messages: Number(r.messages ?? 0),
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
