import type { SupabaseClient } from "@supabase/supabase-js";
import type { Vendor } from "@/lib/types";
import { lastNMonths } from "@/lib/rollup";

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

const FETCH_MONTHS = 24; // wide fixed window so the client can switch to any period

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

/**
 * Fetch the full metered-spend window ONCE (period-independent); the client
 * re-slices per selected period and shapes via buildPlatformRows. Paginates the
 * 1000-row PostgREST cap — 24 months of metered facts easily exceeds it.
 */
export async function getApiPlatformsScope(supabase: SupabaseClient): Promise<ApiPlatformsScope> {
  const now = new Date();
  const from = lastNMonths(now, FETCH_MONTHS)[0] + "-01";
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
      .order("day")
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

  // Friendly names for keys/projects.
  const names: [string, string][] = [];
  const [{ data: keys }, { data: projects }] = await Promise.all([
    supabase.from("api_keys").select("vendor, external_key_id, name"),
    supabase.from("projects").select("vendor, external_id, name"),
  ]);
  for (const k of keys ?? []) if (k.name) names.push([`${k.vendor}:${k.external_key_id}`, k.name as string]);
  for (const p of projects ?? []) if (p.name) names.push([`${p.vendor}:${p.external_id}`, p.name as string]);

  const earliest = rows.length
    ? rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day).slice(0, 7)
    : now.toISOString().slice(0, 7);
  return { rows, earliest, names };
}
