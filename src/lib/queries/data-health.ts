import type { SupabaseClient } from "@supabase/supabase-js";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";

interface HealthFact { source: string; day: string; entity_key: string; cost_usd: number; employee_id: string | null }

/** Every spend fact (counts/unmatched), paging past PostgREST's 1000-row cap. */
async function fetchAllSpendFacts(supabase: SupabaseClient): Promise<HealthFact[]> {
  const PAGE = 1000;
  const rows: HealthFact[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("source, day, entity_key, cost_usd, employee_id")
      .order("day")
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

export async function getDataHealth(supabase: SupabaseClient): Promise<DataHealth> {
  const [facts, { data: syncs }, { data: imports }, { data: emps }] = await Promise.all([
    fetchAllSpendFacts(supabase),
    supabase.from("sync_runs").select("source, finished_at, started_at, status").order("started_at", { ascending: false }),
    supabase.from("imports").select("source, data_as_of, created_at").order("created_at", { ascending: false }),
    supabase.from("employees").select("id, full_name").order("full_name"),
  ]);

  const lastSync = new Map<string, { at: string | null; status: string }>();
  for (const s of syncs ?? []) if (!lastSync.has(s.source)) lastSync.set(s.source, { at: (s.finished_at ?? s.started_at) as string, status: s.status as string });

  const lastImport = new Map<string, string>();
  for (const i of imports ?? []) if (!lastImport.has(i.source)) lastImport.set(i.source, i.data_as_of as string);

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

  return {
    identity: {
      label: "Okta",
      employeeCount: (emps ?? []).length,
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
    employees: (emps ?? []).map((e) => ({ id: e.id as string, name: e.full_name as string })),
  };
}
