import type { SupabaseClient } from "@supabase/supabase-js";
import type { Vendor } from "@/lib/types";
import { earliestFactDay } from "./common";

export interface PlatformFactRow {
  source: Vendor;
  entityKey: string;
  model: string;
  costUsd: number;
  ownerName: string | null;
}

/** A metered fact carrying its day, so the client can slice by period. */
export interface PlatformScopeRow extends PlatformFactRow {
  day: string; // YYYY-MM-DD
}

export interface ApiPlatformsScope {
  rows: PlatformScopeRow[];
  earliest: string; // first month with metered data (YYYY-MM), caps back-stepping
  names: [string, string][]; // [`${vendor}:${id}`, friendlyName] — serializable for the client
}

export interface PlatformEntity {
  source: Vendor;
  entityKey: string;
  name: string; // friendly key/project name when known
  owner: string | null; // creator/owner employee name
  total: number;
  models: { model: string; cost: number }[];
}

/** Pure: group metered facts by (source, key/project) with a model breakdown. */
export function buildPlatformRows(
  rows: PlatformFactRow[],
  nameByKey: Map<string, string>,
): PlatformEntity[] {
  const groups = new Map<string, PlatformEntity & { _models: Map<string, number> }>();

  for (const r of rows) {
    const id = `${r.source}:${r.entityKey}`;
    const g =
      groups.get(id) ??
      ({
        source: r.source,
        entityKey: r.entityKey,
        name: nameByKey.get(id) ?? r.entityKey,
        owner: r.ownerName,
        total: 0,
        models: [],
        _models: new Map<string, number>(),
      } as PlatformEntity & { _models: Map<string, number> });
    g.total += r.costUsd;
    if (r.model) g._models.set(r.model, (g._models.get(r.model) ?? 0) + r.costUsd);
    if (!g.owner && r.ownerName) g.owner = r.ownerName;
    groups.set(id, g);
  }

  return [...groups.values()]
    .map(({ _models, ...g }) => ({
      ...g,
      models: [..._models.entries()]
        .map(([model, cost]) => ({ model, cost }))
        .sort((a, b) => b.cost - a.cost),
    }))
    .sort((a, b) => b.total - a.total);
}

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

/**
 * Fetch the full metered-spend window ONCE (period-independent); the client
 * re-slices per selected period and shapes via buildPlatformRows. Paginates the
 * 1000-row PostgREST cap — a multi-month range of metered facts easily exceeds it.
 */
export async function getApiPlatformsScope(supabase: SupabaseClient): Promise<ApiPlatformsScope> {
  const now = new Date();
  const firstDay = await earliestFactDay(supabase);
  const from = (firstDay ?? now.toISOString().slice(0, 10)).slice(0, 7) + "-01";
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));

  const PAGE = 1000;
  const rows: PlatformScopeRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("day, source, entity_key, model, cost_usd, employees(full_name)")
      .eq("cost_type", "metered")
      .gte("day", from)
      .lt("day", toExclusive)
      // id tiebreaker keeps page boundaries stable across queries.
      .order("day")
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`getApiPlatformsScope: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const emp = Array.isArray(r.employees) ? r.employees[0] : r.employees;
      rows.push({
        day: r.day as string,
        source: r.source as Vendor,
        entityKey: r.entity_key as string,
        model: (r.model as string) ?? "",
        costUsd: Number(r.cost_usd),
        ownerName: (emp as { full_name: string | null } | undefined)?.full_name ?? null,
      });
    }
    if (data.length < PAGE) break;
  }

  // Friendly names for keys/projects (paginated past the 1000-row cap —
  // beyond it entities silently fall back to raw ids).
  const readAll = async (table: string, columns: string) => {
    const all: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase.from(table).select(columns).order("id").range(offset, offset + PAGE - 1);
      if (error) throw new Error(`getApiPlatformsScope (${table}): ${error.message}`);
      all.push(...((data ?? []) as unknown as Record<string, unknown>[]));
      if (!data || data.length < PAGE) break;
    }
    return all;
  };
  const names: [string, string][] = [];
  const [keys, projects] = await Promise.all([
    readAll("api_keys", "vendor, external_key_id, name"),
    readAll("projects", "vendor, external_id, name"),
  ]);
  for (const k of keys) if (k.name) names.push([`${k.vendor}:${k.external_key_id}`, k.name as string]);
  for (const p of projects) if (p.name) names.push([`${p.vendor}:${p.external_id}`, p.name as string]);

  const earliest = rows.length
    ? rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day).slice(0, 7)
    : now.toISOString().slice(0, 7);
  return { rows, earliest, names };
}
