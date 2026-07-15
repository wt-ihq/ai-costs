import type { CostType, SpendFact } from "@/lib/types";
import { SchemaDriftError } from "@/lib/ingest/types";

/**
 * Vercel Invoicing API — FOCUS-formatted charges (one row per charge line,
 * 1-day granularity). We only read the handful of fields we need; FOCUS
 * carries many more (see the spec) that we ignore.
 */
export interface FocusCharge {
  BilledCost: number;
  ChargeCategory: string; // Usage | Purchase | Credit | Adjustment | Tax
  ChargePeriodStart: string;
  ServiceName: string;
  Tags?: Record<string, string>; // ProjectId / ProjectName when project-scoped
  [k: string]: unknown;
}

/** FOCUS ChargeCategory → our cost types. Unknown categories throw — money
 * must never be silently dropped or misfiled. */
const CATEGORY_TO_COST_TYPE: Record<string, CostType> = {
  Purchase: "subscription",
  Tax: "subscription",
  Usage: "metered",
  Credit: "metered", // negative BilledCost passes through
  Adjustment: "metered",
};

/** FOCUS charges (1-day granularity) → facts per (day, costType, entity, service). */
export function normalizeVercel(charges: FocusCharge[]): SpendFact[] {
  const byKey = new Map<string, SpendFact>();
  for (const c of charges) {
    if (typeof c.BilledCost !== "number" || !c.ChargePeriodStart || !c.ChargeCategory || !c.ServiceName) {
      throw new SchemaDriftError("vercel", `charge missing required fields: ${JSON.stringify(c).slice(0, 160)}`);
    }
    const costType = CATEGORY_TO_COST_TYPE[c.ChargeCategory];
    if (!costType) throw new SchemaDriftError("vercel", `unknown ChargeCategory "${c.ChargeCategory}"`);
    const day = c.ChargePeriodStart.slice(0, 10);
    const entityKey = c.Tags?.ProjectName ?? c.Tags?.ProjectId ?? "team";
    const k = `${day}|${costType}|${entityKey}|${c.ServiceName}`;
    const f = byKey.get(k) ?? {
      source: "vercel" as const, day, costType, entityKey, model: c.ServiceName, costUsd: 0, employeeId: null,
    };
    f.costUsd = Math.round((f.costUsd + c.BilledCost) * 100) / 100;
    byKey.set(k, f);
  }
  return [...byKey.values()];
}
