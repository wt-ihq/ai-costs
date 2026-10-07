import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShapeFact } from "@/lib/explore/shape";
import { fetchEmployeesAll, fetchFactsInRange } from "@/lib/queries/common";
import { getSourceHorizons, getToolColors } from "@/lib/queries/explore";
import { buildImportCoverage, getImportCoverageScope, type CoverageMonthRow } from "@/lib/queries/import-coverage";
import { NO_FIXED_COST_SETTINGS, type FixedCostSettings } from "./fixed-costs";
import type { SyncRunRow } from "./freshness";
import { NOTIFY_EMPLOYEE_COLUMNS, toNotifyEmployee, type Cadence, type NotifyEmployee, type SendMode } from "./types";

export interface SendKey {
  employeeId: string;
  cadence: Cadence;
  periodKey: string;
  mode: SendMode;
}

export interface SendResult {
  status: "sent" | "skipped" | "failed";
  slackTs?: string;
  detail?: string; // never names or amounts
}

/** Everything runNotify / the admin preview need from the database — injectable for tests (memory-store.ts). */
export interface NotifyStore {
  subscriptions(cadences: Cadence[]): Promise<{ employeeId: string; cadence: Cadence }[]>;
  employees(): Promise<NotifyEmployee[]>;
  facts(from: string, toExclusive: string): Promise<ShapeFact[]>;
  sourceHorizons(): Promise<Record<string, string>>;
  toolColors(): Promise<Record<string, string>>;
  recentSyncRuns(sinceIso: string): Promise<SyncRunRow[]>;
  importCoverage(nowMonth: string): Promise<CoverageMonthRow[]>;
  /** notification_settings: the organisation default and per-team / per-person overrides. */
  fixedCostSettings(): Promise<FixedCostSettings>;
  /** Existing send rows for these period keys in one mode — lets a run skip the heavy data load when nothing is left to send. */
  sendStates(periodKeys: string[], mode: SendMode): Promise<(SendKey & { status: string; attempts: number })[]>;
  /** Insert a pending row; true = this run owns the send. */
  claimSend(key: SendKey): Promise<boolean>;
  finishSend(key: SendKey, r: SendResult): Promise<void>;
  /** Pending rows older than the cutoff → failed "interrupted", never retried. Returns how many. */
  expireStalePending(olderThanIso: string): Promise<number>;
  slackUser(employeeId: string): Promise<{ slackUserId: string | null; tz: string | null; lookedUpAt: string } | null>;
  /** null = looked up, not found. */
  saveSlackUser(employeeId: string, user: { id: string; tz: string | null } | null): Promise<void>;
}

export const MAX_SEND_ATTEMPTS = 3;

/**
 * A claim conflict may be taken over only when the earlier attempt FAILED
 * before posting and has attempts left. Interrupted rows are stamped with
 * MAX_SEND_ATTEMPTS, so they never qualify — we can't know whether that DM
 * went out, and never-twice beats always-once.
 */
export function canRetakeClaim(existing: { status: string; attempts: number }): boolean {
  return existing.status === "failed" && existing.attempts < MAX_SEND_ATTEMPTS;
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Page past PostgREST's 1000-row cap (gotcha #1). The query MUST order by a unique key. */
export async function pageAll<T>(query: (from: number, to: number) => PageResult<T>, label: string): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/** notification_settings rows → settings. No org row = the default (exclude). */
export function toFixedCostSettings(rows: { scope: string; scope_key: string; include_fixed: boolean }[]): FixedCostSettings {
  const out: FixedCostSettings = { orgInclude: NO_FIXED_COST_SETTINGS.orgInclude, departments: {}, employees: {} };
  for (const r of rows) {
    if (r.scope === "org") out.orgInclude = r.include_fixed;
    else if (r.scope === "department") out.departments[r.scope_key] = r.include_fixed;
    else if (r.scope === "employee") out.employees[r.scope_key] = r.include_fixed;
  }
  return out;
}

const keyMatch = (k: SendKey) => ({ employee_id: k.employeeId, cadence: k.cadence, period_key: k.periodKey, mode: k.mode });

export function supabaseNotifyStore(supabase: SupabaseClient): NotifyStore {
  return {
    async subscriptions(cadences) {
      const rows = await pageAll<{ employee_id: string; cadence: Cadence }>(
        (a, b) => supabase.from("notification_subscriptions").select("employee_id, cadence").in("cadence", cadences).order("employee_id").order("cadence").range(a, b),
        "subscriptions",
      );
      return rows.map((r) => ({ employeeId: r.employee_id, cadence: r.cadence }));
    },
    async employees() {
      return (await fetchEmployeesAll(supabase, NOTIFY_EMPLOYEE_COLUMNS)).map(toNotifyEmployee);
    },
    async facts(from, toExclusive) {
      return fetchFactsInRange(supabase, from, toExclusive);
    },
    sourceHorizons: () => getSourceHorizons(supabase),
    toolColors: () => getToolColors(supabase),
    async recentSyncRuns(sinceIso) {
      const rows = await pageAll<{ source: string; status: string; started_at: string }>(
        (a, b) => supabase.from("sync_runs").select("source, status, started_at").gte("started_at", sinceIso).order("started_at", { ascending: false }).order("id").range(a, b),
        "recentSyncRuns",
      );
      return rows.map((r) => ({ source: r.source, status: r.status, startedAt: r.started_at }));
    },
    async importCoverage(nowMonth) {
      const scope = await getImportCoverageScope(supabase);
      return buildImportCoverage(scope.facts, scope.imports, nowMonth);
    },
    async sendStates(periodKeys, mode) {
      if (!periodKeys.length) return [];
      const rows = await pageAll<{ employee_id: string; cadence: Cadence; period_key: string; status: string; attempts: number }>(
        (a, b) =>
          supabase
            .from("notification_sends")
            .select("employee_id, cadence, period_key, status, attempts")
            .in("period_key", periodKeys)
            .eq("mode", mode)
            .order("id")
            .range(a, b),
        "sendStates",
      );
      return rows.map((r) => ({ employeeId: r.employee_id, cadence: r.cadence, periodKey: r.period_key, mode, status: r.status, attempts: r.attempts }));
    },
    async fixedCostSettings() {
      const rows = await pageAll<{ scope: string; scope_key: string; include_fixed: boolean }>(
        (a, b) => supabase.from("notification_settings").select("scope, scope_key, include_fixed").order("scope").order("scope_key").range(a, b),
        "fixedCostSettings",
      );
      return toFixedCostSettings(rows);
    },
    async claimSend(key) {
      const { error } = await supabase.from("notification_sends").insert({ ...keyMatch(key), status: "pending" });
      if (!error) return true;
      if (error.code !== "23505") throw new Error(`claimSend: ${error.message}`);
      const { data: existing, error: readErr } = await supabase.from("notification_sends").select("status, attempts").match(keyMatch(key)).single();
      if (readErr) throw new Error(`claimSend(read): ${readErr.message}`);
      if (!canRetakeClaim(existing as { status: string; attempts: number })) return false;
      // Optimistic takeover: only succeeds if nobody else retook it first.
      const { data: taken, error: takeErr } = await supabase
        .from("notification_sends")
        .update({ status: "pending", attempts: (existing.attempts as number) + 1, detail: null, updated_at: new Date().toISOString() })
        .match({ ...keyMatch(key), status: "failed", attempts: existing.attempts })
        .select("id");
      if (takeErr) throw new Error(`claimSend(retake): ${takeErr.message}`);
      return (taken?.length ?? 0) === 1;
    },
    async finishSend(key, r) {
      const { error } = await supabase
        .from("notification_sends")
        .update({ status: r.status, slack_ts: r.slackTs ?? null, detail: r.detail ?? null, updated_at: new Date().toISOString() })
        .match(keyMatch(key));
      if (error) throw new Error(`finishSend: ${error.message}`);
    },
    async expireStalePending(olderThanIso) {
      const { data, error } = await supabase
        .from("notification_sends")
        .update({ status: "failed", detail: "interrupted", attempts: MAX_SEND_ATTEMPTS, updated_at: new Date().toISOString() })
        .eq("status", "pending")
        .lt("updated_at", olderThanIso)
        .select("id");
      if (error) throw new Error(`expireStalePending: ${error.message}`);
      return data?.length ?? 0;
    },
    async slackUser(employeeId) {
      const { data, error } = await supabase.from("slack_users").select("slack_user_id, tz, looked_up_at").eq("employee_id", employeeId).maybeSingle();
      if (error) throw new Error(`slackUser: ${error.message}`);
      return data
        ? { slackUserId: (data.slack_user_id as string | null) ?? null, tz: (data.tz as string | null) ?? null, lookedUpAt: data.looked_up_at as string }
        : null;
    },
    async saveSlackUser(employeeId, user) {
      const { error } = await supabase
        .from("slack_users")
        .upsert(
          { employee_id: employeeId, slack_user_id: user?.id ?? null, tz: user?.tz ?? null, looked_up_at: new Date().toISOString() },
          { onConflict: "employee_id" },
        );
      if (error) throw new Error(`saveSlackUser: ${error.message}`);
    },
  };
}
