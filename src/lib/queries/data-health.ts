import type { SupabaseClient } from "@supabase/supabase-js";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";

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

export interface DataHealth {
  sources: SourceHealth[];
  unmatched: UnmatchedEntity[];
  employees: { id: string; name: string }[];
}

const VENDORS = Object.keys(VENDOR_LABEL) as Vendor[];

export async function getDataHealth(supabase: SupabaseClient): Promise<DataHealth> {
  const [{ data: facts }, { data: syncs }, { data: imports }, { data: emps }] = await Promise.all([
    supabase.from("spend_facts").select("source, day, entity_key, cost_usd, employee_id"),
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
