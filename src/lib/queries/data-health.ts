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

/**
 * By-design person-less entity keys. They carry real spend but must never be
 * offered for assignment — attributing them to an individual would be wrong.
 */
export function isPseudoEntity(entityKey: string): boolean {
  return entityKey.startsWith("unassigned seats") || entityKey === "unkeyed" || entityKey === "org";
}

/** One-line explanation for a pseudo-entity, shown beside its spend. */
export function pseudoExplanation(entityKey: string): string {
  if (entityKey.startsWith("unassigned seats")) return "Seat spend beyond known members — backfilled months without member data";
  if (entityKey === "unkeyed") return "Anthropic days with cost but no per-key usage rows to allocate";
  if (entityKey === "org") return "OpenAI org-level costs not tied to a project";
  return "";
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
  /** Person-less spend (unassigned seats, unkeyed, org) — informational, not assignable. */
  pseudo: UnmatchedEntity[];
  employees: { id: string; name: string }[];
  /** Employees with no Okta department — their spend lands in Explore's Unattributed. */
  noDepartment: { id: string; name: string; left: boolean }[];
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
    // "chatgpt_seats"/"claude_seats" (the Okta group syncs) have no spend-fact/
    // vendor row of their own — each is folded onto its vendor row below — but
    // their sync_runs rows must still be fetched or a failed run is invisible
    // on Data Health.
    latestPerSource(supabase, "sync_runs", ["okta", ...VENDORS, "chatgpt_seats", "claude_seats"], "source, finished_at, started_at, status", "started_at"),
    latestPerSource(supabase, "imports", VENDORS, "source, data_as_of, created_at", "created_at"),
    fetchEmployeesAll(supabase, "id, full_name, department, employment_status"),
  ]);

  const lastSync = new Map<string, { at: string | null; status: string }>();
  for (const [source, s] of syncs) lastSync.set(source, { at: (s.finished_at ?? s.started_at) as string, status: s.status as string });

  /**
   * chatgpt_business and claude_team each have no sync of their own
   * (manual-import only) apart from their Okta-group seat sync
   * (chatgpt_seats / claude_seats) that now populates seat facts. Fold the two
   * signals together per vendor by picking whichever ran later, so a failed
   * seat sync (group missing/renamed/no permission) surfaces as a failure on
   * the vendor row instead of nowhere.
   */
  const SEAT_SYNC: Partial<Record<Vendor, string>> = { chatgpt_business: "chatgpt_seats", claude_team: "claude_seats" };
  function syncFor(source: Vendor): { at: string | null; status: string } | undefined {
    const direct = lastSync.get(source);
    const seatsKey = SEAT_SYNC[source];
    const seats = seatsKey ? lastSync.get(seatsKey) : undefined;
    if (!direct) return seats;
    if (!seats) return direct;
    return (seats.at ?? "") >= (direct.at ?? "") ? seats : direct;
  }

  const lastImport = new Map<string, string>();
  for (const [source, i] of imports) lastImport.set(source, i.data_as_of as string);

  const count = new Map<string, number>();
  const latest = new Map<string, string>();
  const unmatched = new Map<string, UnmatchedEntity>();
  const pseudo = new Map<string, UnmatchedEntity>();
  for (const f of facts ?? []) {
    count.set(f.source, (count.get(f.source) ?? 0) + 1);
    if (!latest.get(f.source) || (f.day as string) > latest.get(f.source)!) latest.set(f.source, f.day as string);
    if (f.employee_id == null) {
      // Person-less pseudo-entities are shown for transparency but excluded
      // from the assignable queue — assigning them to a person would be wrong.
      const bucket = isPseudoEntity(f.entity_key) ? pseudo : unmatched;
      const k = `${f.source}:${f.entity_key}`;
      const u = bucket.get(k) ?? { source: f.source as Vendor, entityKey: f.entity_key as string, total: 0, rows: 0 };
      u.total += Number(f.cost_usd);
      u.rows += 1;
      bucket.set(k, u);
    }
  }

  const employees = emps
    .map((e) => ({ id: e.id as string, name: (e.full_name as string | null) ?? "(unnamed)" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const noDepartment = emps
    .filter((e) => e.department == null)
    .map((e) => ({
      id: e.id as string,
      name: (e.full_name as string | null) ?? "(unnamed)",
      left: ["deprovisioned", "suspended"].includes((e.employment_status as string | null) ?? ""),
    }))
    .sort((a, b) => Number(a.left) - Number(b.left) || a.name.localeCompare(b.name));

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
      lastSyncAt: syncFor(source)?.at ?? null,
      lastSyncStatus: syncFor(source)?.status ?? null,
      lastImportAsOf: lastImport.get(source) ?? null,
    })),
    unmatched: [...unmatched.values()].sort((a, b) => b.total - a.total),
    pseudo: [...pseudo.values()].sort((a, b) => b.total - a.total),
    employees,
    noDepartment,
  };
}
