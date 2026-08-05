import type { SupabaseClient } from "@supabase/supabase-js";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import { finishSyncRun, replaceWindowFacts, startSyncRun, type ResolvedFact } from "@/lib/ingest/persist";

export interface RecurringEntry {
  tool: string;
  /**
   * Which vendor the cost belongs to. 'other' = the generic "Other tools"
   * bucket (each tool its own Explore row); a real vendor (e.g. 'openrouter')
   * materializes the facts under that source as cost_type='subscription', so
   * Explore shows one vendor row split subscription vs synced usage.
   */
  vendor: Vendor;
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
      const k = `${e.vendor}|${entityKey}|${month}`;
      const f = byKey.get(k) ?? {
        source: e.vendor,
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

/** The user-supplied half of a recurring entry — months as YYYY-MM, as the form sends them. */
export interface RecurringCostFields {
  tool: string;
  vendor: Vendor;
  kind: "monthly" | "contract";
  amount: number;
  currency: "USD" | "GBP" | "EUR";
  fxRate: number;
  startMonth: string;      // YYYY-MM
  endMonth: string | null; // YYYY-MM
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Returns a human-readable reason the entry can't be saved, or null if it's
 * fine. Lives here (not in the action) so it is unit-testable and so callers
 * can show the reason: a Server Action that *throws* has its message stripped
 * in production builds, which left every rejection reading as an opaque
 * "error occurred in the Server Components render".
 */
export function validateRecurringInput(input: RecurringCostFields): string | null {
  if (!input.tool.trim()) return "Tool name is required.";
  if (!(input.vendor in VENDOR_LABEL)) return `Unknown vendor "${input.vendor}".`;
  if (!MONTH_RE.test(input.startMonth)) return `Invalid start month "${input.startMonth}" — expected YYYY-MM.`;
  if (input.endMonth && !MONTH_RE.test(input.endMonth)) return `Invalid end month "${input.endMonth}" — expected YYYY-MM.`;
  if (input.kind === "contract" && !input.endMonth) return "Contracts need an end month.";
  if (input.endMonth && input.endMonth < input.startMonth) {
    return `End month (${input.endMonth}) is before the start month (${input.startMonth}).`;
  }
  if (!Number.isFinite(input.amount) || input.amount < 0) return "Amount must be a number ≥ 0.";
  const fxRate = input.currency === "USD" ? 1 : input.fxRate;
  if (!Number.isFinite(fxRate) || fxRate <= 0) return "A conversion rate > 0 is required.";
  return null;
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
      .select("id, tool, vendor, color_slot, department, kind, amount, currency, fx_rate, start_month, end_month")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetchRecurringEntries: ${error.message}`);
    for (const r of data ?? []) {
      out.push({
        id: r.id as string,
        tool: r.tool as string,
        vendor: (r.vendor as Vendor) ?? "other",
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
 * The replace window's startDate is the EARLIER of (earliest stored derived
 * fact, earliest recomputed fact) — not just the recomputed minimum. If an
 * entry's range shifts forward (start_month edited later, or an early entry
 * deleted while others remain), previously-materialized facts before the new
 * earliest day would otherwise fall outside the window and replaceWindowFacts
 * would never scan them, leaving them as stale spend forever. Anchoring to
 * the stored minimum too ensures a forward-shifted entry range still prunes
 * its orphaned early months.
 */
async function replaceStart(
  supabase: SupabaseClient,
  source: string,
  facts: ResolvedFact[],
  costType: string | null,
): Promise<string> {
  const newMin = facts.reduce((min, f) => (f.day < min ? f.day : min), facts[0].day);
  let query = supabase.from("spend_facts").select("day").eq("source", source);
  if (costType) query = query.eq("cost_type", costType);
  const { data, error } = await query.order("day").limit(1);
  if (error) throw new Error(`rebuildRecurringFacts earliest(${source}): ${error.message}`);
  const existingMinDay = (data?.[0]?.day as string | undefined) ?? null;
  return existingMinDay && existingMinDay < newMin ? existingMinDay : newMin;
}

/**
 * Rebuild ALL recurring-derived facts from recurring_costs (the source of
 * truth). These facts are purely derived, so clearing a source that no longer
 * has entries cannot lose information (deliberate, documented exception to
 * gotcha #4's spirit).
 *
 * Per source: 'other' facts are recurring-derived in their entirety (zero
 * entries → full clear); a real vendor's derived facts are ONLY its
 * cost_type='subscription' rows, so both the replace and the clear are scoped
 * to that cost type — its synced seat/metered facts are never touched. The
 * scoped clear is what un-materializes an entry that was re-tagged to another
 * vendor or deleted.
 */
export async function rebuildRecurringFacts(supabase: SupabaseClient): Promise<number> {
  const entries = await fetchRecurringEntries(supabase);
  const throughMonth = new Date().toISOString().slice(0, 7) + "-01";
  const facts = computeRecurringFacts(entries, throughMonth);
  const endDate = throughMonth.slice(0, 8) + "02"; // exclusive-end just past current month-01

  const bySource = new Map<Vendor, ResolvedFact[]>();
  for (const f of facts) {
    const source = f.source as Vendor;
    (bySource.get(source) ?? bySource.set(source, []).get(source)!).push(f);
  }

  let written = 0;
  for (const vendor of Object.keys(VENDOR_LABEL) as Vendor[]) {
    const vendorFacts = bySource.get(vendor) ?? [];
    const scope = vendor === "other" ? null : "subscription";
    if (vendorFacts.length === 0) {
      let clear = supabase.from("spend_facts").delete().eq("source", vendor);
      if (scope) clear = clear.eq("cost_type", scope);
      const { error } = await clear;
      if (error) throw new Error(`rebuildRecurringFacts clear(${vendor}): ${error.message}`);
      continue;
    }
    const startDate = await replaceStart(supabase, vendor, vendorFacts, scope);
    written += await replaceWindowFacts(
      supabase,
      vendor,
      { startDate, endDate },
      vendorFacts,
      scope ? { costType: "subscription" } : undefined,
    );
  }
  return written;
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
