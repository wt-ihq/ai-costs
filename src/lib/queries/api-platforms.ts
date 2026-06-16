import type { SupabaseClient } from "@supabase/supabase-js";
import type { Vendor } from "@/lib/types";
import { monthRange } from "./common";

export interface PlatformFactRow {
  source: Vendor;
  entityKey: string;
  model: string;
  costUsd: number;
  ownerName: string | null;
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

export async function getApiPlatformsData(supabase: SupabaseClient, now: Date) {
  const range = monthRange(now);

  const { data, error } = await supabase
    .from("spend_facts")
    .select("source, entity_key, model, cost_usd, employees(full_name)")
    .eq("cost_type", "metered")
    .gte("day", range.from)
    .lt("day", range.toExclusive);
  if (error) throw new Error(`getApiPlatformsData: ${error.message}`);

  const rows: PlatformFactRow[] = (data ?? []).map((r) => {
    const emp = Array.isArray(r.employees) ? r.employees[0] : r.employees;
    return {
      source: r.source as Vendor,
      entityKey: r.entity_key as string,
      model: (r.model as string) ?? "",
      costUsd: Number(r.cost_usd),
      ownerName: (emp as { full_name: string | null } | undefined)?.full_name ?? null,
    };
  });

  // Friendly names for keys/projects.
  const nameByKey = new Map<string, string>();
  const [{ data: keys }, { data: projects }] = await Promise.all([
    supabase.from("api_keys").select("vendor, external_key_id, name"),
    supabase.from("projects").select("vendor, external_id, name"),
  ]);
  for (const k of keys ?? []) if (k.name) nameByKey.set(`${k.vendor}:${k.external_key_id}`, k.name as string);
  for (const p of projects ?? []) if (p.name) nameByKey.set(`${p.vendor}:${p.external_id}`, p.name as string);

  return { month: range.month, entities: buildPlatformRows(rows, nameByKey) };
}
