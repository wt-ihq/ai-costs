import type { ResolvedFact } from "@/lib/ingest/persist";

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
        costType: "seat" as const,
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
