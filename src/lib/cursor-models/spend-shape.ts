import type { CursorSpendRow, CursorSpendScope } from "@/lib/queries/cursor-spend";
import type { Period } from "@/lib/explore/period";

export type { CursorSpendRow, CursorSpendScope };

export interface CursorSpendData {
  total: number;
  seat: number;
  overage: number;
  byModel: { model: string; cost: number }[]; // overage only
  byPerson: { name: string; cost: number }[]; // seat + overage
}

/** Pure: slice the scope to the period and aggregate spend. */
export function buildCursorSpendData(scope: CursorSpendScope, period: Period): CursorSpendData {
  const rows = scope.rows.filter((r) => r.day >= period.from && r.day < period.toExclusive);

  let seat = 0;
  let overage = 0;
  const modelTotals = new Map<string, number>();
  const personTotals = new Map<string, number>();
  for (const r of rows) {
    if (r.costType === "seat") {
      seat += r.costUsd;
    } else {
      overage += r.costUsd;
      const model = r.model || "(no model)";
      modelTotals.set(model, (modelTotals.get(model) ?? 0) + r.costUsd);
    }
    const person = r.personName ?? "Unattributed";
    personTotals.set(person, (personTotals.get(person) ?? 0) + r.costUsd);
  }

  return {
    total: seat + overage,
    seat,
    overage,
    byModel: [...modelTotals.entries()]
      .map(([model, cost]) => ({ model, cost }))
      .sort((a, b) => b.cost - a.cost),
    byPerson: [...personTotals.entries()]
      .map(([name, cost]) => ({ name, cost }))
      .sort((a, b) => b.cost - a.cost),
  };
}
