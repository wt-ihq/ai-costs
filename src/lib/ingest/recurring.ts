import type { SupabaseClient } from "@supabase/supabase-js";
import { finishSyncRun, replaceWindowFacts, startSyncRun, type ResolvedFact } from "@/lib/ingest/persist";

export interface RecurringEntry {
  tool: string;
  department: string | null;
  kind: "monthly" | "contract";
  amount: number;         // per month (monthly) or total (contract), in `currency`
  fxRate: number;         // to USD; 1 for USD
  startMonth: string;     // YYYY-MM-01
  endMonth: string | null; // inclusive; non-null for contracts (app-enforced)
}

/** Inclusive YYYY-MM-01 list from start to end. */
export function monthsBetween(startMonth: string, endMonth: string): string[] {
  const out: string[] = [];
  let [y, m] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Derived facts for all recurring entries, through `throughMonth` (the
 * current UTC month — future months appear as time passes). Monthly entries
 * repeat round(amount × fx, 2); contracts split their USD total cent-exactly
 * across the FULL contract period (last month absorbs the remainder), then
 * clip to throughMonth. One fact per (tool, month, department).
 */
export function computeRecurringFacts(entries: RecurringEntry[], throughMonth: string): ResolvedFact[] {
  const byKey = new Map<string, ResolvedFact>();
  for (const e of entries) {
    const monthCents = new Map<string, number>();
    if (e.kind === "monthly") {
      const end = e.endMonth && e.endMonth < throughMonth ? e.endMonth : throughMonth;
      if (e.startMonth > end) continue;
      const cents = Math.round(e.amount * e.fxRate * 100);
      for (const m of monthsBetween(e.startMonth, end)) monthCents.set(m, cents);
    } else {
      const months = monthsBetween(e.startMonth, e.endMonth!); // full period drives the split
      const totalCents = Math.round(e.amount * e.fxRate * 100);
      const per = Math.floor(totalCents / months.length);
      months.forEach((m, i) => {
        if (m > throughMonth) return;
        monthCents.set(m, i === months.length - 1 ? totalCents - per * (months.length - 1) : per);
      });
    }
    for (const [month, cents] of monthCents) {
      const entityKey = e.tool.toLowerCase() + (e.department ? `|${e.department}` : "");
      const k = `${entityKey}|${month}`;
      const f = byKey.get(k) ?? {
        source: "other" as const,
        day: month,
        costType: "subscription" as const,
        entityKey,
        costUsd: 0,
        model: e.tool,
        department: e.department,
        employeeId: null,
      };
      f.costUsd = Math.round((f.costUsd * 100 + cents)) / 100;
      byKey.set(k, f);
    }
  }
  return [...byKey.values()];
}

/** Stable color slot: a known tool keeps its slot; new tools take the lowest free, else the least-used (lowest wins ties). */
export function pickColorSlot(existing: { tool: string; colorSlot: number }[], tool: string): number {
  const known = existing.find((t) => t.tool.toLowerCase() === tool.toLowerCase());
  if (known) return known.colorSlot;
  const counts = Array.from({ length: 8 }, () => 0);
  for (const t of existing) counts[t.colorSlot] += 1;
  const min = Math.min(...counts);
  return counts.indexOf(min);
}

/** All recurring entries (paginated, gotcha #1 — the table grows forever). */
export async function fetchRecurringEntries(
  supabase: SupabaseClient,
): Promise<(RecurringEntry & { id: string; colorSlot: number; currency: string })[]> {
  const PAGE = 1000;
  const out: (RecurringEntry & { id: string; colorSlot: number; currency: string })[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("recurring_costs")
      .select("id, tool, color_slot, department, kind, amount, currency, fx_rate, start_month, end_month")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetchRecurringEntries: ${error.message}`);
    for (const r of data ?? []) {
      out.push({
        id: r.id as string,
        tool: r.tool as string,
        colorSlot: Number(r.color_slot),
        department: (r.department as string) ?? null,
        kind: r.kind as "monthly" | "contract",
        amount: Number(r.amount),
        currency: r.currency as string,
        fxRate: Number(r.fx_rate),
        startMonth: r.start_month as string,
        endMonth: (r.end_month as string) ?? null,
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * Rebuild ALL source='other' facts from recurring_costs (the source of
 * truth). Zero entries is the one intentional full clear — these facts are
 * purely derived, so wiping them cannot lose information (deliberate,
 * documented exception to gotcha #4's spirit).
 *
 * The replace window's startDate is the EARLIER of (earliest stored
 * other-fact, earliest recomputed fact) — not just the recomputed minimum.
 * If an entry's range shifts forward (start_month edited later, or an early
 * entry deleted while others remain), previously-materialized facts before
 * the new earliest day would otherwise fall outside the window and
 * replaceWindowFacts would never scan them, leaving them as stale spend
 * forever. Anchoring to the stored minimum too ensures a forward-shifted
 * entry range still prunes its orphaned early months.
 */
export async function rebuildRecurringFacts(supabase: SupabaseClient): Promise<number> {
  const entries = await fetchRecurringEntries(supabase);
  const throughMonth = new Date().toISOString().slice(0, 7) + "-01";
  const facts = computeRecurringFacts(entries, throughMonth);
  if (facts.length === 0) {
    const { error } = await supabase.from("spend_facts").delete().eq("source", "other");
    if (error) throw new Error(`rebuildRecurringFacts clear: ${error.message}`);
    return 0;
  }
  const newMin = facts.reduce((min, f) => (f.day < min ? f.day : min), facts[0].day);
  const { data: earliestExisting, error: earliestError } = await supabase
    .from("spend_facts")
    .select("day")
    .eq("source", "other")
    .order("day")
    .limit(1);
  if (earliestError) throw new Error(`rebuildRecurringFacts earliest: ${earliestError.message}`);
  const existingMinDay = (earliestExisting?.[0]?.day as string | undefined) ?? null;
  const startDate = existingMinDay && existingMinDay < newMin ? existingMinDay : newMin;
  const window = { startDate, endDate: throughMonth.slice(0, 8) + "02" }; // exclusive-end just past current month-01
  return replaceWindowFacts(supabase, "other", window, facts);
}

/** Nightly cron step: extends open-ended monthlies into each new month. */
export async function syncRecurring(supabase: SupabaseClient): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "recurring");
  try {
    const rowsWritten = await rebuildRecurringFacts(supabase);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
