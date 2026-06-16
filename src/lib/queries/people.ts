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

export interface EmployeeLite {
  id: string;
  fullName: string | null;
  department: string | null;
}

/**
 * Pure: one row per EMPLOYEE (the roster), with this month's attributed spend
 * left-joined (zeros if none). Employee-driven so the whole org shows even
 * before any spend is attributed; unmatched spend lives on Data Health.
 */
export function buildPeopleRows(facts: EnrichedFact[], employees: EmployeeLite[]): PersonRow[] {
  const byEmp = new Map<string, PersonRow & { _seats: Set<Vendor> }>();

  // Seed every employee so the roster is complete.
  for (const e of employees) {
    byEmp.set(e.id, {
      employeeId: e.id,
      name: e.fullName ?? "(unknown)",
      department: e.department,
      seatVendors: [],
      seatCost: 0,
      overage: 0,
      metered: 0,
      total: 0,
      activityUsd: 0,
      zeroActivity: false,
      _seats: new Set<Vendor>(),
    });
  }

  for (const f of facts) {
    if (!f.employeeId) continue; // unmatched spend lives on Data Health
    const row = byEmp.get(f.employeeId);
    if (!row) continue; // attributed to someone not in the roster

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
  const [facts, { data: emps, error }] = await Promise.all([
    fetchMonthFacts(supabase, range),
    supabase.from("employees").select("id, full_name, department"),
  ]);
  if (error) throw new Error(`getPeopleData: ${error.message}`);
  const employees: EmployeeLite[] = (emps ?? []).map((e) => ({
    id: e.id as string,
    fullName: e.full_name as string | null,
    department: e.department as string | null,
  }));
  return { month: range.month, rows: buildPeopleRows(facts, employees) };
}
