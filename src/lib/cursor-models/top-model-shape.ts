import type { TopModelRow } from "@/lib/queries/cursor-top-model";
import type { Period } from "@/lib/explore/period";
import { modelColor, type ModelBar } from "@/lib/cursor-models/shape";

export type { TopModelRow };

export interface TopModelPerson {
  id: string;
  name: string;
  primaryModel: string;
  days: number; // days seen in period
}

export interface TopModelData {
  period: Period;
  earliest: string;
  activeUsers: number;
  modelCount: number;
  distribution: ModelBar[]; // users per primary model
  people: TopModelPerson[];
}

/** The most frequent value in a list (ties broken by first-seen). */
function mode(values: string[]): string {
  const counts = new Map<string, number>();
  let best = values[0] ?? "";
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

export function buildTopModelData(scope: { rows: TopModelRow[]; earliest: string }, period: Period): TopModelData {
  const rows = scope.rows.filter((r) => r.day >= period.from && r.day < period.toExclusive);

  // Group by person → their daily top-models in the period.
  const byPerson = new Map<string, { name: string; models: string[] }>();
  for (const r of rows) {
    const id = r.employeeId ?? `unmatched:${r.entityKey}`;
    const g = byPerson.get(id) ?? { name: r.fullName ?? r.entityKey, models: [] };
    g.models.push(r.model);
    byPerson.set(id, g);
  }

  const people: TopModelPerson[] = [...byPerson.entries()]
    .map(([id, g]) => ({ id, name: g.name, primaryModel: mode(g.models), days: g.models.length }))
    .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));

  // Team distribution: how many people have each model as their primary.
  const perModel = new Map<string, number>();
  for (const p of people) perModel.set(p.primaryModel, (perModel.get(p.primaryModel) ?? 0) + 1);
  const distribution: ModelBar[] = [...perModel.entries()]
    .map(([model, value]) => ({ key: model, label: model, value, color: modelColor(model) }))
    .sort((a, b) => b.value - a.value);

  return {
    period,
    earliest: scope.earliest,
    activeUsers: people.length,
    modelCount: perModel.size,
    distribution,
    people,
  };
}
