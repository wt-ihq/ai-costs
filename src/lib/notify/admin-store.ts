import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { fixedCostsForTeam, type FixedCostChoice, type FixedCostSettings } from "./fixed-costs";
import { pageAll, supabaseNotifyStore } from "./store";
import { buildReportingTree } from "./tree";
import { activeDepartments, CADENCES, isActiveEmployee, NOTIFY_EMPLOYEE_COLUMNS, toNotifyEmployee, type Cadence, type SendMode } from "./types";

export interface RecipientRow {
  employeeId: string;
  name: string;
  team: string | null;
  cadences: Cadence[];
  reports: number; // active descendants
  slack: "found" | "not_found" | "unknown";
  lastSent: string | null; // newest LIVE send "weekly · 2026-09-28"; "preview · weekly · 2026-09-28" if only previews went
  left: boolean;
  /** Fixed costs: the person's own override (null = none) and what applies without it (team, else default). */
  fixedCosts: { override: boolean | null; inherited: FixedCostChoice };
}
export interface SendLogRow { at: string; name: string; cadence: string; periodKey: string; mode: string; status: string; detail: string | null }
export interface LastRun {
  day: string;
  mode: SendMode; // live if any live row that day, else preview
  cadences: Cadence[]; // present that day, either mode
  sent: number; // counts are for `mode` only
  skipped: number;
  failed: number;
  plusPreview: number; // preview rows the same day when mode is live
}
/** A pickable employee: `label` is "Name — Team (email)". */
export interface PersonOption { id: string; label: string; name: string }
export interface NotificationsAdminData {
  recipients: RecipientRow[];
  sends: SendLogRow[]; // newest first, ≤ 50
  lastRun: LastRun | null;
  tree: { active: number; resolved: number; unresolved: string[] };
  people: PersonOption[]; // active, not yet enrolled — the recipients table's add-a-person picker
  activePeople: PersonOption[]; // every active employee — the preview and test-send pickers
  departments: string[];
  fixedCosts: FixedCostSettings;
}

type SendRowLite = { employee_id: string; cadence: string; mode: string; status: string; updated_at: string };

/** Rows newest first. Each person's newest LIVE send; their newest preview only when no live one exists. */
export function lastSentLabels(rows: Pick<SendRowLite, "employee_id" | "cadence" | "mode" | "updated_at">[]): Map<string, string> {
  const live = new Map<string, string>();
  const preview = new Map<string, string>();
  for (const r of rows) {
    const into = r.mode === "live" ? live : preview;
    if (!into.has(r.employee_id)) into.set(r.employee_id, `${r.cadence} · ${r.updated_at.slice(0, 10)}`);
  }
  for (const [id, label] of preview) if (!live.has(id)) live.set(id, `preview · ${label}`);
  return live;
}

/** Rows newest first. The latest day's run: its mode, cadences and that mode's outcome counts. */
export function summariseLastRun(sends: Pick<SendRowLite, "cadence" | "mode" | "status" | "updated_at">[]): LastRun | null {
  const day = sends[0]?.updated_at.slice(0, 10);
  if (!day) return null;
  const ofDay = sends.filter((s) => s.updated_at.startsWith(day));
  const mode: SendMode = ofDay.some((s) => s.mode === "live") ? "live" : "preview";
  const shown = ofDay.filter((s) => s.mode === mode);
  const count = (status: string) => shown.filter((s) => s.status === status).length;
  return {
    day,
    mode,
    cadences: CADENCES.filter((c) => ofDay.some((s) => s.cadence === c)),
    sent: count("sent"),
    skipped: count("skipped"),
    failed: count("failed"),
    plusPreview: ofDay.length - shown.length,
  };
}

const LAST_SENT_LOOKBACK_DAYS = 40;

/** Paginated (gotcha #1): one recipient can have many rows, so a bounded newest-N read could miss someone. */
async function loadLastSent(supabase: SupabaseClient, enrolledIds: string[]): Promise<Map<string, string>> {
  if (!enrolledIds.length) return new Map();
  const since = new Date(Date.now() - LAST_SENT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = await pageAll<Pick<SendRowLite, "employee_id" | "cadence" | "mode" | "updated_at">>(
    (a, b) =>
      supabase
        .from("notification_sends")
        .select("employee_id, cadence, mode, updated_at")
        .in("employee_id", enrolledIds)
        .eq("status", "sent")
        .gte("updated_at", since)
        .order("updated_at", { ascending: false })
        .order("id")
        .range(a, b),
    "notification_sends(last sent)",
  );
  return lastSentLabels(rows);
}

export async function loadNotificationsAdmin(supabase: SupabaseClient): Promise<NotificationsAdminData> {
  const subsP = pageAll<{ employee_id: string; cadence: Cadence }>(
    (a, b) => supabase.from("notification_subscriptions").select("employee_id, cadence").order("employee_id").order("cadence").range(a, b),
    "notification_subscriptions",
  );
  const [subs, lastSent, empRows, slackRows, sendRes, fixedCosts] = await Promise.all([
    subsP,
    subsP.then((rows) => loadLastSent(supabase, [...new Set(rows.map((r) => r.employee_id))])),
    fetchEmployeesAll(supabase, NOTIFY_EMPLOYEE_COLUMNS),
    pageAll<{ employee_id: string; slack_user_id: string | null }>(
      (a, b) => supabase.from("slack_users").select("employee_id, slack_user_id").order("employee_id").range(a, b),
      "slack_users",
    ),
    // Bounded newest-first read of a growing log — never a full scan.
    supabase.from("notification_sends").select("employee_id, cadence, period_key, mode, status, detail, updated_at").order("updated_at", { ascending: false }).order("id").limit(200),
    supabaseNotifyStore(supabase).fixedCostSettings(),
  ]);
  if (sendRes.error) throw new Error(`notification_sends: ${sendRes.error.message}`);

  const employees = empRows.map(toNotifyEmployee);
  const byId = new Map(employees.map((e) => [e.id, e]));
  const tree = buildReportingTree(employees);
  const slack = new Map(slackRows.map((r) => [r.employee_id, r.slack_user_id]));
  const sends = (sendRes.data ?? []) as (SendRowLite & { period_key: string; detail: string | null })[];

  const cadencesBy = new Map<string, Cadence[]>();
  for (const s of subs) cadencesBy.set(s.employee_id, [...(cadencesBy.get(s.employee_id) ?? []), s.cadence]);

  const recipients: RecipientRow[] = [...cadencesBy].map(([id, cadences]): RecipientRow => {
    const e = byId.get(id);
    return {
      employeeId: id,
      name: e?.fullName ?? "Unknown",
      team: e?.department ?? null,
      cadences,
      reports: tree.reportsOf(id).filter((r) => { const x = byId.get(r); return x ? isActiveEmployee(x) : false; }).length,
      slack: !slack.has(id) ? "unknown" : slack.get(id) ? "found" : "not_found",
      lastSent: lastSent.get(id) ?? null,
      left: e ? !isActiveEmployee(e) : true,
      fixedCosts: { override: id in fixedCosts.employees ? fixedCosts.employees[id] : null, inherited: fixedCostsForTeam(fixedCosts, e?.department ?? null) },
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const active = employees.filter(isActiveEmployee);
  const unresolved = new Set(tree.unresolved);
  const activePeople = active
    .map((e): PersonOption => ({ id: e.id, name: e.fullName, label: `${e.fullName} — ${e.department ?? "No team"} (${e.email})` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    recipients,
    sends: sends.slice(0, 50).map((s) => ({
      at: s.updated_at, name: byId.get(s.employee_id)?.fullName ?? "Unknown", cadence: s.cadence,
      periodKey: s.period_key, mode: s.mode, status: s.status, detail: s.detail,
    })),
    lastRun: summariseLastRun(sends),
    tree: { active: active.length, resolved: active.filter((e) => !unresolved.has(e.id)).length, unresolved: active.filter((e) => unresolved.has(e.id)).map((e) => e.fullName).sort() },
    people: activePeople.filter((p) => !cadencesBy.has(p.id)),
    activePeople,
    departments: activeDepartments(employees),
    fixedCosts,
  };
}

export type FixedCostScope = "org" | "department" | "employee";

/** Set one fixed-costs setting; `include` null removes it (a team/person falls back; the org reverts to exclude). */
export async function setFixedCostSetting(
  supabase: SupabaseClient,
  scope: FixedCostScope,
  scopeKey: string,
  include: boolean | null,
  updatedBy: string,
): Promise<void> {
  const key = scope === "org" ? "" : scopeKey;
  const { error } =
    include === null
      ? await supabase.from("notification_settings").delete().eq("scope", scope).eq("scope_key", key)
      : await supabase
          .from("notification_settings")
          .upsert({ scope, scope_key: key, include_fixed: include, updated_by: updatedBy, updated_at: new Date().toISOString() }, { onConflict: "scope,scope_key" });
  if (error) throw new Error(`setFixedCostSetting: ${error.message}`);
}

export async function addSubscriptions(supabase: SupabaseClient, employeeIds: string[], cadences: Cadence[], createdBy: string): Promise<number> {
  const rows = employeeIds.flatMap((employee_id) => cadences.map((cadence) => ({ employee_id, cadence, created_by: createdBy })));
  const { data, error } = await supabase
    .from("notification_subscriptions")
    .upsert(rows, { onConflict: "employee_id,cadence", ignoreDuplicates: true })
    .select("employee_id");
  if (error) throw new Error(`addSubscriptions: ${error.message}`);
  return data?.length ?? 0;
}

export async function setSubscription(supabase: SupabaseClient, employeeId: string, cadence: Cadence, enabled: boolean, createdBy: string): Promise<void> {
  if (enabled) {
    await addSubscriptions(supabase, [employeeId], [cadence], createdBy);
    return;
  }
  const { error } = await supabase.from("notification_subscriptions").delete().eq("employee_id", employeeId).eq("cadence", cadence);
  if (error) throw new Error(`setSubscription: ${error.message}`);
}

export async function removeSubscriptions(supabase: SupabaseClient, employeeId: string): Promise<void> {
  const { error } = await supabase.from("notification_subscriptions").delete().eq("employee_id", employeeId);
  if (error) throw new Error(`removeSubscriptions: ${error.message}`);
}
