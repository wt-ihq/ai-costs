import type { SupabaseClient } from "@supabase/supabase-js";
import { earliestFactDay } from "./common";

/** One Cursor spend fact, enriched with the attributed employee's name. */
export interface CursorSpendRow {
  day: string; // YYYY-MM-DD
  costType: "seat" | "overage";
  model: string; // "" for seat facts
  costUsd: number;
  personName: string | null; // null when unmatched
}

export interface CursorSpendScope {
  rows: CursorSpendRow[];
}

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

/** Fetch the full Cursor seat+overage window once; the client slices by period. */
export async function getCursorSpendScope(supabase: SupabaseClient): Promise<CursorSpendScope> {
  const now = new Date();
  const firstDay = await earliestFactDay(supabase);
  const from = (firstDay ?? now.toISOString().slice(0, 10)).slice(0, 7) + "-01";
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));

  // Count-first pagination: the first page carries the exact total so the
  // rest fetch CONCURRENTLY instead of serially.
  const PAGE = 1000;
  const page = (withCount: boolean) =>
    supabase
      .from("spend_facts")
      .select("day, cost_type, model, cost_usd, employees(full_name)", withCount ? { count: "exact" } : undefined)
      .eq("source", "cursor")
      .in("cost_type", ["seat", "overage"])
      .gte("day", from)
      .lt("day", toExclusive)
      // id tiebreaker keeps page boundaries stable across queries.
      .order("day")
      .order("id");

  const { data: first, count, error } = await page(true).range(0, PAGE - 1);
  if (error) throw new Error(`getCursorSpendScope: ${error.message}`);
  const raw: Record<string, unknown>[] = [...((first as Record<string, unknown>[]) ?? [])];
  const total = count ?? raw.length;
  if (total > PAGE) {
    const rest = await Promise.all(
      Array.from({ length: Math.ceil(total / PAGE) - 1 }, (_, i) => page(false).range((i + 1) * PAGE, (i + 2) * PAGE - 1)),
    );
    for (const p of rest) {
      if (p.error) throw new Error(`getCursorSpendScope: ${p.error.message}`);
      raw.push(...((p.data as Record<string, unknown>[]) ?? []));
    }
  }
  const rows: CursorSpendRow[] = raw.map((r) => {
    const emp = Array.isArray(r.employees) ? r.employees[0] : r.employees;
    return {
      day: r.day as string,
      costType: r.cost_type as "seat" | "overage",
      model: (r.model as string) ?? "",
      costUsd: Number(r.cost_usd),
      personName: (emp as { full_name: string | null } | undefined)?.full_name ?? null,
    };
  });
  return { rows };
}
