import type { SupabaseClient } from "@supabase/supabase-js";
import type { Vendor } from "@/lib/types";
import { fetchMonthFacts, monthRange, type EnrichedFact } from "./common";

export interface PersonRow {
  employeeId: string;
  name: string;
  department: string | null;
  seatVendors: Vendor[]; // vendors where they hold a seat
  seatCost: number;
  overage: number;
  metered: number;
  total: number;
  activityUsd: number; // overage + metered (usage signal)
  /** seat cost but no usage this month — the seat-hygiene flag */
  zeroActivity: boolean;
}

/** Pure: collapse a month of facts into one row per employee. */
export function buildPeopleRows(facts: EnrichedFact[]): PersonRow[] {
  const byEmp = new Map<string, PersonRow & { _seats: Set<Vendor> }>();

  for (const f of facts) {
    if (!f.employeeId) continue; // unmatched spend lives on Data Health
    const row =
      byEmp.get(f.employeeId) ??
      ({
        employeeId: f.employeeId,
        name: f.fullName ?? "(unknown)",
        department: f.department,
        seatVendors: [],
        seatCost: 0,
        overage: 0,
        metered: 0,
        total: 0,
        activityUsd: 0,
        zeroActivity: false,
        _seats: new Set<Vendor>(),
      } as PersonRow & { _seats: Set<Vendor> });

    if (f.costType === "seat") {
      row.seatCost += f.costUsd;
      row._seats.add(f.source);
    } else if (f.costType === "overage") {
      row.overage += f.costUsd;
    } else {
      row.metered += f.costUsd;
    }
    row.total += f.costUsd;
    byEmp.set(f.employeeId, row);
  }

  return [...byEmp.values()]
    .map(({ _seats, ...r }) => {
      const activityUsd = r.overage + r.metered;
      return {
        ...r,
        seatVendors: [..._seats].sort(),
        activityUsd,
        zeroActivity: r.seatCost > 0 && activityUsd === 0,
      };
    })
    .sort((a, b) => b.total - a.total);
}

export async function getPeopleData(supabase: SupabaseClient, now: Date) {
  const range = monthRange(now);
  const facts = await fetchMonthFacts(supabase, range);
  return { month: range.month, rows: buildPeopleRows(facts) };
}
