import type { SupabaseClient } from "@supabase/supabase-js";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import { fetchEmployeesAll } from "./common";

interface HealthFact { source: string; day: string; entity_key: string; cost_usd: number; employee_id: string | null }

/** Every spend fact (counts/unmatched), paging past PostgREST's 1000-row cap. */
async function fetchAllSpendFacts(supabase: SupabaseClient): Promise<HealthFact[]> {
  const PAGE = 1000;
  const rows: HealthFact[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("source, day, entity_key, cost_usd, employee_id")
      // id tiebreaker: `day` alone has thousands of ties, so page boundaries
      // could duplicate/skip rows between queries.
      .order("day")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`getDataHealth: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as HealthFact[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

export interface SourceHealth {
  source: Vendor;
  factCount: number;
  latestDay: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastImportAsOf: string | null;
}

export interface UnmatchedEntity {
  source: Vendor;
  entityKey: string;
  total: number;
  rows: number;
}

/** The identity spine (Okta) — has no spend facts, but its own freshness. */
export interface IdentityHealth {
  label: string;
  employeeCount: number;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
}

export interface DataHealth {
  identity: IdentityHealth;
  sources: SourceHealth[];
  unmatched: UnmatchedEntity[];
  employees: { id: string; name: string }[];
}

const VENDORS = Object.keys(VENDOR_LABEL) as Vendor[];

/**
 * Latest sync/import row per source, one LIMIT-1 query each. Reading the whole
 * table capped at 1000 rows meant a source that stopped syncing long enough
 * ago fell off the page and rendered as "never synced" — hiding exactly the
 * staleness this page exists to surface (sync_runs grows ~daily × sources).
 */
async function latestPerSource(
  supabase: SupabaseClient,
  table: "sync_runs" | "imports",
  sources: string[],
  columns: string,
  orderCol: string,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  await Promise.all(
    sources.map(async (source) => {
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .eq("source", source)
        .order(orderCol, { ascending: false })
        .limit(1);
      if (error) throw new Error(`getDataHealth (${table}/${source}): ${error.message}`);
      if (data?.[0]) out.set(source, data[0] as unknown as Record<string, unknown>);
    }),
  );
  return out;
}

export async function getDataHealth(supabase: SupabaseClient): Promise<DataHealth> {
  const [facts, syncs, imports, emps] = await Promise.all([
    fetchAllSpendFacts(supabase),
    latestPerSource(supabase, "sync_runs", ["okta", ...VENDORS], "source, finished_at, started_at, status", "started_at"),
    latestPerSource(supabase, "imports", VENDORS, "source, data_as_of, created_at", "created_at"),
    fetchEmployeesAll(supabase, "id, full_name"),
  ]);

  const lastSync = new Map<string, { at: string | null; status: string }>();
  for (const [source, s] of syncs) lastSync.set(source, { at: (s.finished_at ?? s.started_at) as string, status: s.status as string });

  const lastImport = new Map<string, string>();
  for (const [source, i] of imports) lastImport.set(source, i.data_as_of as string);

  const count = new Map<string, number>();
  const latest = new Map<string, string>();
  const unmatched = new Map<string, UnmatchedEntity>();
  for (const f of facts ?? []) {
    count.set(f.source, (count.get(f.source) ?? 0) + 1);
    if (!latest.get(f.source) || (f.day as string) > latest.get(f.source)!) latest.set(f.source, f.day as string);
    if (f.employee_id == null) {
      const k = `${f.source}:${f.entity_key}`;
      const u = unmatched.get(k) ?? { source: f.source as Vendor, entityKey: f.entity_key as string, total: 0, rows: 0 };
      u.total += Number(f.cost_usd);
      u.rows += 1;
      unmatched.set(k, u);
    }
  }

  const employees = emps
    .map((e) => ({ id: e.id as string, name: (e.full_name as string | null) ?? "(unnamed)" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    identity: {
      label: "Okta",
      employeeCount: emps.length,
      lastSyncAt: lastSync.get("okta")?.at ?? null,
      lastSyncStatus: lastSync.get("okta")?.status ?? null,
    },
    sources: VENDORS.map((source) => ({
      source,
      factCount: count.get(source) ?? 0,
      latestDay: latest.get(source) ?? null,
      lastSyncAt: lastSync.get(source)?.at ?? null,
      lastSyncStatus: lastSync.get(source)?.status ?? null,
      lastImportAsOf: lastImport.get(source) ?? null,
    })),
    unmatched: [...unmatched.values()].sort((a, b) => b.total - a.total),
    employees,
  };
}
