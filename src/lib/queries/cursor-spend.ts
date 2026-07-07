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

  const PAGE = 1000;
  const rows: CursorSpendRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("day, cost_type, model, cost_usd, employees(full_name)")
      .eq("source", "cursor")
      .in("cost_type", ["seat", "overage"])
      .gte("day", from)
      .lt("day", toExclusive)
      // id tiebreaker keeps page boundaries stable across queries.
      .order("day")
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`getCursorSpendScope: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const emp = Array.isArray(r.employees) ? r.employees[0] : r.employees;
      rows.push({
        day: r.day as string,
        costType: r.cost_type as "seat" | "overage",
        model: (r.model as string) ?? "",
        costUsd: Number(r.cost_usd),
        personName: (emp as { full_name: string | null } | undefined)?.full_name ?? null,
      });
    }
    if (data.length < PAGE) break;
  }
  return { rows };
}
