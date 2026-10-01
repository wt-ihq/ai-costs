import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { pageAll } from "./store";
import { buildReportingTree } from "./tree";
import { isActiveEmployee, NOTIFY_EMPLOYEE_COLUMNS, toNotifyEmployee, type Cadence } from "./types";

export interface RecipientRow {
  employeeId: string;
  name: string;
  team: string | null;
  cadences: Cadence[];
  reports: number; // active descendants
  slack: "found" | "not_found" | "unknown";
  lastSent: string | null; // "weekly · 2026-09-28"
  left: boolean;
}
export interface SendLogRow { at: string; name: string; cadence: string; periodKey: string; mode: string; status: string; detail: string | null }
export interface NotificationsAdminData {
  recipients: RecipientRow[];
  sends: SendLogRow[]; // newest first, ≤ 50
  lastRun: { day: string; sent: number; skipped: number; failed: number } | null;
  tree: { active: number; resolved: number; unresolved: string[] };
  people: { id: string; label: string }[]; // active, not yet enrolled — "Name — Team"
  departments: string[];
}

export async function loadNotificationsAdmin(supabase: SupabaseClient): Promise<NotificationsAdminData> {
  const [subs, empRows, slackRows, sendRes] = await Promise.all([
    pageAll<{ employee_id: string; cadence: Cadence }>(
      (a, b) => supabase.from("notification_subscriptions").select("employee_id, cadence").order("employee_id").order("cadence").range(a, b),
      "notification_subscriptions",
    ),
    fetchEmployeesAll(supabase, NOTIFY_EMPLOYEE_COLUMNS),
    pageAll<{ employee_id: string; slack_user_id: string | null }>(
      (a, b) => supabase.from("slack_users").select("employee_id, slack_user_id").order("employee_id").range(a, b),
      "slack_users",
    ),
    // Bounded newest-first read of a growing log — never a full scan.
    supabase.from("notification_sends").select("employee_id, cadence, period_key, mode, status, detail, updated_at").order("updated_at", { ascending: false }).order("id").limit(200),
  ]);
  if (sendRes.error) throw new Error(`notification_sends: ${sendRes.error.message}`);

  const employees = empRows.map(toNotifyEmployee);
  const byId = new Map(employees.map((e) => [e.id, e]));
  const tree = buildReportingTree(employees);
  const slack = new Map(slackRows.map((r) => [r.employee_id, r.slack_user_id]));
  const sends = (sendRes.data ?? []) as { employee_id: string; cadence: string; period_key: string; mode: string; status: string; detail: string | null; updated_at: string }[];

  const cadencesBy = new Map<string, Cadence[]>();
  for (const s of subs) cadencesBy.set(s.employee_id, [...(cadencesBy.get(s.employee_id) ?? []), s.cadence]);

  const recipients: RecipientRow[] = [...cadencesBy].map(([id, cadences]): RecipientRow => {
    const e = byId.get(id);
    const last = sends.find((s) => s.employee_id === id && s.status === "sent");
    return {
      employeeId: id,
      name: e?.fullName ?? "Unknown",
      team: e?.department ?? null,
      cadences,
      reports: tree.reportsOf(id).filter((r) => { const x = byId.get(r); return x ? isActiveEmployee(x) : false; }).length,
      slack: !slack.has(id) ? "unknown" : slack.get(id) ? "found" : "not_found",
      lastSent: last ? `${last.cadence} · ${last.updated_at.slice(0, 10)}` : null,
      left: e ? !isActiveEmployee(e) : true,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const lastDay = sends[0]?.updated_at.slice(0, 10) ?? null;
  const ofLastDay = lastDay ? sends.filter((s) => s.updated_at.startsWith(lastDay)) : [];
  const active = employees.filter(isActiveEmployee);
  const unresolved = new Set(tree.unresolved);

  return {
    recipients,
    sends: sends.slice(0, 50).map((s) => ({
      at: s.updated_at, name: byId.get(s.employee_id)?.fullName ?? "Unknown", cadence: s.cadence,
      periodKey: s.period_key, mode: s.mode, status: s.status, detail: s.detail,
    })),
    lastRun: lastDay
      ? { day: lastDay, sent: ofLastDay.filter((s) => s.status === "sent").length, skipped: ofLastDay.filter((s) => s.status === "skipped").length, failed: ofLastDay.filter((s) => s.status === "failed").length }
      : null,
    tree: { active: active.length, resolved: active.filter((e) => !unresolved.has(e.id)).length, unresolved: active.filter((e) => unresolved.has(e.id)).map((e) => e.fullName).sort() },
    people: active.filter((e) => !cadencesBy.has(e.id)).map((e) => ({ id: e.id, label: `${e.fullName} — ${e.department ?? "No team"}` })).sort((a, b) => a.label.localeCompare(b.label)),
    departments: [...new Set(active.map((e) => e.department).filter((d): d is string => !!d))].sort(),
  };
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
