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

/** True when a cost would display as more than $0.00. */
const hasSpend = (usd: number) => Math.abs(usd) >= 0.005;

/**
 * Pure: group metered facts by (source, key/project) with a model breakdown.
 * Line items and entities that would display as $0.00 are left out (Vercel
 * bills dozens of zero-cost usage lines); entity totals still include them.
 */
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
    .filter((g) => hasSpend(g.total))
    .map(({ _models, ...g }) => ({
      ...g,
      models: [..._models.entries()]
        .filter(([, cost]) => hasSpend(cost))
        .map(([model, cost]) => ({ model, cost }))
        .sort((a, b) => b.cost - a.cost),
    }))
    .sort((a, b) => b.total - a.total);
}

/** Pure: metered total per vendor (for the tile row / filter). */
export function buildVendorTotals(rows: PlatformFactRow[]): Map<Vendor, number> {
  const totals = new Map<Vendor, number>();
  for (const r of rows) totals.set(r.source, (totals.get(r.source) ?? 0) + r.costUsd);
  return totals;
}

/** Pure: metered spend per owner; ownerless keys bucket as "Unattributed". */
export function buildPersonRows(rows: PlatformFactRow[]): { name: string; total: number }[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const name = r.ownerName ?? "Unattributed";
    totals.set(name, (totals.get(name) ?? 0) + r.costUsd);
  }
  return [...totals.entries()]
    .map(([name, total]) => ({ name, total }))
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

  // The first page also asks for the exact total, so the rest are read a few at a time instead of
  // one after another: this window is every metered fact on record (Vercel alone bills thousands
  // of lines a month), and dozens of sequential round trips made the page take many seconds.
  const PAGE = 1000;
  const CONCURRENCY = 6;
  const page = (index: number, withCount: boolean) =>
    supabase
      .from("spend_facts")
      .select("day, source, entity_key, model, cost_usd, employees(full_name)", withCount ? { count: "exact" } : undefined)
      .eq("cost_type", "metered")
      // OpenRouter has its own page with richer analytics (tokens/requests/
      // trend); here it would only duplicate that as bare per-email rows.
      // This page is the direct-platforms view — kept as the historical
      // record as those are deprecated in favour of OpenRouter.
      .neq("source", "openrouter")
      .gte("day", from)
      .lt("day", toExclusive)
      // id tiebreaker keeps page boundaries stable across queries.
      .order("day")
      .order("id")
      .range(index * PAGE, (index + 1) * PAGE - 1);

  const first = await page(0, true);
  if (first.error) throw new Error(`getApiPlatformsScope: ${first.error.message}`);
  const pages = [first.data ?? []];
  const pageCount = Math.ceil((first.count ?? pages[0].length) / PAGE);
  for (let next = 1; next < pageCount; next += CONCURRENCY) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pageCount - next) }, (_, i) => page(next + i, false)),
    );
    for (const p of batch) {
      if (p.error) throw new Error(`getApiPlatformsScope: ${p.error.message}`);
      pages.push(p.data ?? []);
    }
  }

  let firstDayWithRows: string | null = null;
  const rows: PlatformScopeRow[] = [];
  for (const data of pages) {
    for (const r of data) {
      const day = r.day as string;
      if (firstDayWithRows === null || day < firstDayWithRows) firstDayWithRows = day;
      const costUsd = Number(r.cost_usd);
      // A $0 line adds nothing to any total on the page, and Vercel bills dozens of them per
      // project per day: left out of what is cached and sent to the browser.
      if (costUsd === 0) continue;
      const emp = Array.isArray(r.employees) ? r.employees[0] : r.employees;
      rows.push({
        day,
        source: r.source as Vendor,
        entityKey: r.entity_key as string,
        model: (r.model as string) ?? "",
        costUsd,
        ownerName: (emp as { full_name: string | null } | undefined)?.full_name ?? null,
      });
    }
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

  const earliest = (firstDayWithRows ?? now.toISOString()).slice(0, 7);
  return { rows, earliest, names };
}

/**
 * The cache/wire form of the scope: string tables plus index tuples, as Explore's scopes are
 * (explore/pack.ts). Dates, keys, models and owner names repeat across thousands of rows, so the
 * plain rows are mostly repetition — packed, the scope fits the data cache's item cap and is a
 * fraction of the download.
 */
export interface PackedApiPlatformsScope {
  earliest: string;
  names: [string, string][];
  days: string[];
  sources: string[];
  entityKeys: string[];
  models: string[];
  owners: string[];
  /** [day, source, entityKey, model, owner (-1 = none), costUsd] */
  rows: [number, number, number, number, number, number][];
}

export function packApiPlatformsScope(scope: ApiPlatformsScope): PackedApiPlatformsScope {
  const table = () => {
    const index = new Map<string, number>();
    const values: string[] = [];
    const intern = (value: string): number => {
      let i = index.get(value);
      if (i === undefined) {
        i = values.length;
        values.push(value);
        index.set(value, i);
      }
      return i;
    };
    return { values, intern };
  };
  const days = table(), sources = table(), entityKeys = table(), models = table(), owners = table();
  const rows = scope.rows.map(
    (r) =>
      [
        days.intern(r.day), sources.intern(r.source), entityKeys.intern(r.entityKey), models.intern(r.model),
        r.ownerName === null ? -1 : owners.intern(r.ownerName), r.costUsd,
      ] as PackedApiPlatformsScope["rows"][number],
  );
  return {
    earliest: scope.earliest, names: scope.names,
    days: days.values, sources: sources.values, entityKeys: entityKeys.values, models: models.values, owners: owners.values,
    rows,
  };
}

/** Restore the plain scope client-side (memoize the call). */
export function unpackApiPlatformsScope(packed: PackedApiPlatformsScope): ApiPlatformsScope {
  return {
    earliest: packed.earliest,
    names: packed.names,
    rows: packed.rows.map((r) => ({
      day: packed.days[r[0]],
      source: packed.sources[r[1]] as Vendor,
      entityKey: packed.entityKeys[r[2]],
      model: packed.models[r[3]],
      ownerName: r[4] === -1 ? null : packed.owners[r[4]],
      costUsd: r[5],
    })),
  };
}
