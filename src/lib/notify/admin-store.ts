import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { digestStatusRows, type DigestStatusInput, type DigestStatusRow } from "./digest-status";
import { fixedCostsForTeam, type FixedCostChoice, type FixedCostSettings } from "./fixed-costs";
import { periodReadiness, type ReadinessReads } from "./period-readiness";
import { latestCompleteKey, periodFor, stepKey } from "./schedule";
import { pageAll, supabaseNotifyStore } from "./store";
import { buildReportingTree } from "./tree";
import { buildOrgTree, type OrgTree } from "./org-tree";
import { readMonthlyFrom, readStoredMode } from "./mode-store";
import { activeDepartments, CADENCES, isActiveEmployee, NOTIFY_EMPLOYEE_COLUMNS, resolveNotifyMode, toNotifyEmployee, type Cadence, type NotifyMode, type ReportKind, type SendMode, type SendReport } from "./types";

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
/** A company report recipient: the cadences they get it on. */
export interface CompanyRecipientRow {
  employeeId: string;
  name: string;
  team: string | null;
  cadences: Cadence[];
  slack: RecipientRow["slack"];
  left: boolean;
}
export interface SendLogRow { at: string; name: string; report: SendReport; cadence: string; periodKey: string; mode: string; status: string; detail: string | null; openedAt: string | null }
export interface LastRun {
  day: string;
  mode: SendMode; // live if any live row that day, else preview
  cadences: Cadence[]; // present that day, either mode
  sent: number; // counts are for `mode` only
  skipped: number;
  failed: number;
  plusPreview: number; // preview rows the same day when mode is live
}
/** Someone on the update-reminder list. */
export interface ReminderRecipientRow { employeeId: string; name: string; team: string | null; slack: RecipientRow["slack"]; left: boolean }
/** A pickable employee: `label` is "Name — Team (email)". */
export interface PersonOption { id: string; label: string; name: string }
export interface NotificationsAdminData {
  recipients: RecipientRow[];
  companyRecipients: CompanyRecipientRow[];
  companyPeople: PersonOption[]; // active, not on the company list yet: its add-a-person picker
  sends: SendLogRow[]; // newest first, ≤ 50
  lastRun: LastRun | null;
  tree: { active: number; resolved: number; unresolved: string[] };
  /** The reporting lines for the recipient picker (Reporting lines panel). */
  orgTree: OrgTree;
  people: PersonOption[]; // active, not yet enrolled — the recipients table's add-a-person picker
  activePeople: PersonOption[]; // every active employee — the preview and test-send pickers
  departments: string[];
  fixedCosts: FixedCostSettings;
  /** Live digests with the "Open in dashboard" button sent in the last OPEN_RATE_DAYS, and how many were opened from it. */
  opens: { sent: number; opened: number };
  reminderRecipients: ReminderRecipientRow[];
  reminderPeople: PersonOption[]; // active, not on the reminder list: its add-a-person picker
  /** The mode in force (mode-store.ts), and whether it was chosen on this page or comes from the Vercel variable. */
  mode: NotifyMode;
  modeSource: "page" | "env";
  /** The first month that gets a monthly recap ("2026-10"), or null for every month (mode-store.ts). */
  monthlyFrom: string | null;
  /** The weekly and monthly digests in play: status, next automatic send, sent, Send now (digest-status.ts). */
  digests: DigestStatusRow[];
}

export const OPEN_RATE_DAYS = 30;

/** Live sent digests and how many were opened. Previews, skips and failures don't count. */
export function openRate(rows: { mode: string; status: string; opened_at: string | null }[]): { sent: number; opened: number } {
  const sent = rows.filter((r) => r.mode === "live" && r.status === "sent");
  return { sent: sent.length, opened: sent.filter((r) => r.opened_at).length };
}

type SendRowLite = { employee_id: string; cadence: string; mode: string; status: string; updated_at: string; opened_at: string | null };

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
export function summariseLastRun(rows: (Pick<SendRowLite, "cadence" | "mode" | "status" | "updated_at"> & { report?: string })[]): LastRun | null {
  const sends = rows.filter((s) => s.report !== "reminder"); // update reminders aren't digests
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

/** Paginated (gotcha #1): one recipient can have many rows, so a bounded newest-N read could miss someone. Personal sends only: the company report has its own list. */
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
        .eq("report", "personal")
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
  const companyP = pageAll<{ employee_id: string; cadence: Cadence }>(
    (a, b) => supabase.from(RECIPIENT_TABLE.company).select("employee_id, cadence").order("employee_id").order("cadence").range(a, b),
    RECIPIENT_TABLE.company,
  );
  const opensSince = new Date(Date.now() - OPEN_RATE_DAYS * 86_400_000).toISOString();
  const [stored, monthlyFrom] = await Promise.all([readStoredMode(supabase), readMonthlyFrom(supabase)]);
  const mode = resolveNotifyMode(stored, process.env);
  const [subs, companyRows, lastSent, empRows, slackRows, sendRes, fixedCosts, recentSent, reminderRows, digests] = await Promise.all([
    subsP,
    companyP,
    subsP.then((rows) => loadLastSent(supabase, [...new Set(rows.map((r) => r.employee_id))])),
    fetchEmployeesAll(supabase, NOTIFY_EMPLOYEE_COLUMNS),
    pageAll<{ employee_id: string; slack_user_id: string | null }>(
      (a, b) => supabase.from("slack_users").select("employee_id, slack_user_id").order("employee_id").range(a, b),
      "slack_users",
    ),
    // Bounded newest-first read of a growing log — never a full scan.
    supabase.from("notification_sends").select("employee_id, cadence, period_key, mode, report, status, detail, updated_at, opened_at").order("updated_at", { ascending: false }).order("id").limit(200),
    supabaseNotifyStore(supabase).fixedCostSettings(),
    pageAll<{ mode: string; status: string; opened_at: string | null }>(
      // Only messages that had the button: people without dashboard access get none, so can't open one.
      (a, b) => supabase.from("notification_sends").select("mode, status, opened_at").eq("mode", "live").eq("status", "sent").eq("dashboard_link", true).gte("updated_at", opensSince).order("id").range(a, b),
      "notification_sends(opens)",
    ),
    pageAll<{ employee_id: string }>(
      (a, b) => supabase.from("notification_reminder_recipients").select("employee_id").order("employee_id").range(a, b),
      "notification_reminder_recipients",
    ),
    loadDigests(supabase, new Date(), mode, monthlyFrom),
  ]);
  if (sendRes.error) throw new Error(`notification_sends: ${sendRes.error.message}`);

  const employees = empRows.map(toNotifyEmployee);
  const byId = new Map(employees.map((e) => [e.id, e]));
  const tree = buildReportingTree(employees);
  const slack = new Map(slackRows.map((r) => [r.employee_id, r.slack_user_id]));
  const sends = (sendRes.data ?? []) as (SendRowLite & { period_key: string; detail: string | null; report: SendReport })[];

  const byPerson = (rows: { employee_id: string; cadence: Cadence }[]) => {
    const m = new Map<string, Cadence[]>();
    for (const r of rows) m.set(r.employee_id, [...(m.get(r.employee_id) ?? []), r.cadence]);
    return m;
  };
  const cadencesBy = byPerson(subs);
  const companyBy = byPerson(companyRows);
  const slackStatus = (id: string): RecipientRow["slack"] => (!slack.has(id) ? "unknown" : slack.get(id) ? "found" : "not_found");

  const recipients: RecipientRow[] = [...cadencesBy].map(([id, cadences]): RecipientRow => {
    const e = byId.get(id);
    return {
      employeeId: id,
      name: e?.fullName ?? "Unknown",
      team: e?.department ?? null,
      cadences,
      reports: tree.reportsOf(id).filter((r) => { const x = byId.get(r); return x ? isActiveEmployee(x) : false; }).length,
      slack: slackStatus(id),
      lastSent: lastSent.get(id) ?? null,
      left: e ? !isActiveEmployee(e) : true,
      fixedCosts: { override: id in fixedCosts.employees ? fixedCosts.employees[id] : null, inherited: fixedCostsForTeam(fixedCosts, e?.department ?? null) },
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const reminderSet = new Set(reminderRows.map((r) => r.employee_id));
  const reminderRecipients: ReminderRecipientRow[] = [...reminderSet]
    .map((id) => {
      const e = byId.get(id);
      return { employeeId: id, name: e?.fullName ?? "Unknown", team: e?.department ?? null, slack: slackStatus(id), left: e ? !isActiveEmployee(e) : true };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const companyRecipients: CompanyRecipientRow[] = [...companyBy].map(([id, cadences]): CompanyRecipientRow => {
    const e = byId.get(id);
    return { employeeId: id, name: e?.fullName ?? "Unknown", team: e?.department ?? null, cadences, slack: slackStatus(id), left: e ? !isActiveEmployee(e) : true };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const active = employees.filter(isActiveEmployee);
  const unresolved = new Set(tree.unresolved);
  const activePeople = active
    .map((e): PersonOption => ({ id: e.id, name: e.fullName, label: `${e.fullName} — ${e.department ?? "No team"} (${e.email})` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    recipients,
    companyRecipients,
    sends: sends.slice(0, 50).map((s) => ({
      at: s.updated_at, name: byId.get(s.employee_id)?.fullName ?? "Unknown", report: s.report, cadence: s.cadence,
      periodKey: s.period_key, mode: s.mode, status: s.status, detail: s.detail, openedAt: s.opened_at,
    })),
    lastRun: summariseLastRun(sends),
    tree: { active: active.length, resolved: active.filter((e) => !unresolved.has(e.id)).length, unresolved: active.filter((e) => unresolved.has(e.id)).map((e) => e.fullName).sort() },
    orgTree: buildOrgTree(employees, tree, cadencesBy, companyBy),
    people: activePeople.filter((p) => !cadencesBy.has(p.id)),
    companyPeople: activePeople.filter((p) => !companyBy.has(p.id)),
    activePeople,
    departments: activeDepartments(employees),
    fixedCosts,
    opens: openRate(recentSent),
    reminderRecipients,
    reminderPeople: activePeople.filter((p) => !reminderSet.has(p.id)),
    mode,
    modeSource: stored !== null && stored === mode ? "page" : "env",
    monthlyFrom,
    digests,
  };
}

/** The digests table: the latest complete week and month, and the previous ones while they have sends (the cron's readiness rules). */
async function loadDigests(supabase: SupabaseClient, now: Date, mode: NotifyMode, monthlyFrom: string | null): Promise<DigestStatusRow[]> {
  const store = supabaseNotifyStore(supabase);
  const today = now.toISOString().slice(0, 10);
  const sendMode = mode === "preview" ? "preview" : "live";
  const wanted: { cadence: "weekly" | "monthly"; key: string; previous: boolean }[] = [];
  for (const cadence of ["weekly", "monthly"] as const) {
    const key = latestCompleteKey(cadence, now);
    wanted.push({ cadence, key, previous: false });
    const prev = stepKey(cadence, key, -1, now);
    if (prev) wanted.push({ cadence, key: prev, previous: true });
  }
  const reads: ReadinessReads = {};
  const [personal, company, states, readiness] = await Promise.all([
    store.subscriptions(["weekly", "monthly"]),
    store.companyRecipients(["weekly", "monthly"]),
    store.sendStates(wanted.map((w) => w.key), sendMode),
    Promise.all(wanted.map((w) => periodReadiness(store, w.cadence, w.key, now, reads))),
  ]);
  const count = (rows: { cadence: Cadence }[], cadence: Cadence) => rows.filter((s) => s.cadence === cadence).length;
  const periods: DigestStatusInput["periods"] = wanted.map((w, i) => ({
    cadence: w.cadence,
    period: periodFor(w.cadence, w.key, now),
    readiness: readiness[i],
    recipients: { personal: count(personal, w.cadence), company: count(company, w.cadence) },
    sends: states.filter((s) => s.periodKey === w.key && s.cadence === w.cadence && s.report !== "reminder").map((s) => ({ status: s.status, updatedAt: s.updatedAt })),
    previous: w.previous,
  }));
  // Latest week, latest month, then the previous ones.
  periods.sort((a, b) => Number(a.previous) - Number(b.previous));
  return digestStatusRows({ today, mode, previewEmail: process.env.SLACK_PREVIEW_EMAIL ?? null, monthlyFrom, periods });
}

export async function addReminderRecipients(supabase: SupabaseClient, employeeIds: string[], createdBy: string): Promise<number> {
  const { data, error } = await supabase
    .from("notification_reminder_recipients")
    .upsert(employeeIds.map((employee_id) => ({ employee_id, created_by: createdBy })), { onConflict: "employee_id", ignoreDuplicates: true })
    .select("employee_id");
  if (error) throw new Error(`addReminderRecipients: ${error.message}`);
  return data?.length ?? 0;
}

export async function removeReminderRecipient(supabase: SupabaseClient, employeeId: string): Promise<void> {
  const { error } = await supabase.from("notification_reminder_recipients").delete().eq("employee_id", employeeId);
  if (error) throw new Error(`removeReminderRecipient: ${error.message}`);
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

/** Each DM's recipients table (person × cadence). */
export const RECIPIENT_TABLE: Record<ReportKind, string> = {
  personal: "notification_subscriptions",
  company: "notification_company_recipients",
};

export async function addSubscriptions(
  supabase: SupabaseClient,
  employeeIds: string[],
  cadences: Cadence[],
  createdBy: string,
  report: ReportKind = "personal",
): Promise<number> {
  const rows = employeeIds.flatMap((employee_id) => cadences.map((cadence) => ({ employee_id, cadence, created_by: createdBy })));
  const { data, error } = await supabase
    .from(RECIPIENT_TABLE[report])
    .upsert(rows, { onConflict: "employee_id,cadence", ignoreDuplicates: true })
    .select("employee_id");
  if (error) throw new Error(`addSubscriptions: ${error.message}`);
  return data?.length ?? 0;
}

export async function setSubscription(
  supabase: SupabaseClient,
  employeeId: string,
  cadence: Cadence,
  enabled: boolean,
  createdBy: string,
  report: ReportKind = "personal",
): Promise<void> {
  if (enabled) {
    await addSubscriptions(supabase, [employeeId], [cadence], createdBy, report);
    return;
  }
  const { error } = await supabase.from(RECIPIENT_TABLE[report]).delete().eq("employee_id", employeeId).eq("cadence", cadence);
  if (error) throw new Error(`setSubscription: ${error.message}`);
}

export async function removeSubscriptions(supabase: SupabaseClient, employeeId: string, report: ReportKind = "personal"): Promise<void> {
  const { error } = await supabase.from(RECIPIENT_TABLE[report]).delete().eq("employee_id", employeeId);
  if (error) throw new Error(`removeSubscriptions: ${error.message}`);
}

/**
 * "Remove everyone": empties the list — nothing else. Per-person fixed-cost choices and the send log stay,
 * so adding someone back restores them. PostgREST refuses an unfiltered delete; `cadence` is never empty.
 */
export async function removeAllSubscriptions(supabase: SupabaseClient, report: ReportKind = "personal"): Promise<number> {
  const { data, error } = await supabase.from(RECIPIENT_TABLE[report]).delete().neq("cadence", "").select("employee_id");
  if (error) throw new Error(`removeAllSubscriptions: ${error.message}`);
  return data?.length ?? 0;
}
