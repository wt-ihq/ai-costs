import type { ShapeFact } from "./shape";

/**
 * Compact wire format for fact arrays: string tables + per-fact index tuples.
 * UUIDs, departments, entity keys, and model names repeat across thousands of
 * facts, so raw ShapeFact JSON is ~70% redundancy — packing keeps the company
 * scope under the data-cache per-item cap (1.9MB raw exceeded it, silently
 * disabling caching) and slashes the RSC payload the browser downloads and
 * hydrates on every view.
 */
export interface PackedFacts {
  days: string[];
  sources: string[];
  costTypes: string[];
  entityKeys: string[];
  models: string[];
  employeeIds: string[];
  fullNames: string[];
  departments: string[];
  /** [day, source, costType, entityKey, model, employeeId, fullName, department, costUsd] — -1 = null. */
  rows: [number, number, number, number, number, number, number, number, number][];
}

class Table {
  private idx = new Map<string, number>();
  readonly values: string[] = [];
  intern(value: string | null): number {
    if (value === null) return -1;
    let i = this.idx.get(value);
    if (i === undefined) {
      i = this.values.length;
      this.values.push(value);
      this.idx.set(value, i);
    }
    return i;
  }
}

export function packFacts(facts: ShapeFact[]): PackedFacts {
  const days = new Table();
  const sources = new Table();
  const costTypes = new Table();
  const entityKeys = new Table();
  const models = new Table();
  const employeeIds = new Table();
  const fullNames = new Table();
  const departments = new Table();
  const rows = facts.map(
    (f) =>
      [
        days.intern(f.day),
        sources.intern(f.source),
        costTypes.intern(f.costType),
        entityKeys.intern(f.entityKey),
        models.intern(f.model),
        employeeIds.intern(f.employeeId),
        fullNames.intern(f.fullName),
        departments.intern(f.department),
        f.costUsd,
      ] as PackedFacts["rows"][number],
  );
  return {
    days: days.values,
    sources: sources.values,
    costTypes: costTypes.values,
    entityKeys: entityKeys.values,
    models: models.values,
    employeeIds: employeeIds.values,
    fullNames: fullNames.values,
    departments: departments.values,
    rows,
  };
}

export function unpackFacts(packed: PackedFacts): ShapeFact[] {
  const at = (table: string[], i: number): string | null => (i === -1 ? null : table[i]);
  return packed.rows.map((r) => ({
    day: packed.days[r[0]],
    source: packed.sources[r[1]] as ShapeFact["source"],
    costType: packed.costTypes[r[2]] as ShapeFact["costType"],
    entityKey: packed.entityKeys[r[3]],
    model: packed.models[r[4]],
    employeeId: at(packed.employeeIds, r[5]),
    fullName: at(packed.fullNames, r[6]),
    department: at(packed.departments, r[7]),
    costUsd: r[8],
  }));
}
