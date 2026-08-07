import type { SupabaseClient } from "@supabase/supabase-js";
import { earliestFactDay } from "./common";

/** One OpenRouter fact (metered usage or the platform subscription), enriched with the attributed employee's name. */
export interface OpenRouterRow {
  day: string; // YYYY-MM-DD
  costType: "metered" | "subscription"; // subscription = vendor-tagged recurring fee, stamped to the 1st
  entityKey: string; // member email, workspace name, or "unkeyed"
  model: string;
  costUsd: number;
  tokens: number;
  requests: number;
  personName: string | null; // null when unmatched
}

export interface OpenRouterScope {
  rows: OpenRouterRow[];
  earliest: string; // first month with OpenRouter data (YYYY-MM), caps back-stepping
}

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

/** Fetch the full OpenRouter window once; the client slices by period. */
export async function getOpenRouterScope(supabase: SupabaseClient): Promise<OpenRouterScope> {
  const now = new Date();
  const firstDay = await earliestFactDay(supabase);
  const from = (firstDay ?? now.toISOString().slice(0, 10)).slice(0, 7) + "-01";
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));

  // Count-first pagination past the PostgREST 1000-row cap (gotcha #1): the
  // first page carries the exact total so the rest fetch CONCURRENTLY.
  const PAGE = 1000;
  const page = (withCount: boolean) =>
    supabase
      .from("spend_facts")
      .select("day, cost_type, entity_key, model, cost_usd, tokens, requests, employees(full_name)", withCount ? { count: "exact" } : undefined)
      .eq("source", "openrouter")
      // Usage facts plus the vendor-tagged platform subscription — the trend
      // amortizes the latter across the month like Explore does.
      .in("cost_type", ["metered", "subscription"])
      .gte("day", from)
      .lt("day", toExclusive)
      // id tiebreaker keeps page boundaries stable across queries.
      .order("day")
      .order("id");

  const { data: first, count, error } = await page(true).range(0, PAGE - 1);
  if (error) throw new Error(`getOpenRouterScope: ${error.message}`);
  const raw: Record<string, unknown>[] = [...((first as Record<string, unknown>[]) ?? [])];
  const total = count ?? raw.length;
  if (total > PAGE) {
    const rest = await Promise.all(
      Array.from({ length: Math.ceil(total / PAGE) - 1 }, (_, i) => page(false).range((i + 1) * PAGE, (i + 2) * PAGE - 1)),
    );
    for (const p of rest) {
      if (p.error) throw new Error(`getOpenRouterScope: ${p.error.message}`);
      raw.push(...((p.data as Record<string, unknown>[]) ?? []));
    }
  }

  const rows: OpenRouterRow[] = raw.map((r) => {
    const emp = Array.isArray(r.employees) ? r.employees[0] : r.employees;
    return {
      day: r.day as string,
      costType: r.cost_type as "metered" | "subscription",
      entityKey: r.entity_key as string,
      model: (r.model as string) ?? "",
      costUsd: Number(r.cost_usd),
      tokens: Number(r.tokens ?? 0),
      requests: Number(r.requests ?? 0),
      personName: (emp as { full_name: string | null } | undefined)?.full_name ?? null,
    };
  });

  const earliest = rows.length
    ? rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day).slice(0, 7)
    : now.toISOString().slice(0, 7);
  return { rows, earliest };
}
