import { monthlyReadiness } from "./freshness";
import { deliverRendered, PostOutcomeUnknownError, resolveSlackUser, type SlackRecipient } from "./deliver";
import { importsInUseSince, readinessSyncSince, weekReadiness } from "./readiness";
import { monthEndReminder, weeklyReminder } from "./reminders";
import type { RenderedDigest } from "./render";
import { claim, errorDetail, type RunNotifyDeps } from "./run-notify";
import { dueReminders, inMonthlyWindow, latestCompleteKey, periodFor, type DueReminder } from "./schedule";
import type { SendKey } from "./store";
import { isActiveEmployee, type NotifyEmployee } from "./types";

export interface RunRemindersResult {
  due: string[];
  sent: number;
  failed: number;
  alreadyHandled: number;
  waiting: number; // recipients before their reminder time
  /** The run stopped early (e.g. the reminder list was unreadable); the digests still run after it. */
  error?: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Update reminders (spec §4): Monday 09:30 "weekly updates" and the month's last working day 15:00
 * "paste Claude Team", in each recipient's time zone. Claimed in notification_sends (report
 * "reminder") — never twice. Runs before runNotify in the cron; cheap: nothing is loaded unless one is due.
 */
export async function runReminders(deps: RunNotifyDeps): Promise<RunRemindersResult> {
  const log = deps.log ?? console.log;
  const result: RunRemindersResult = { due: [], sent: 0, failed: 0, alreadyHandled: 0, waiting: 0 };
  try {
    return await remind(deps, result, log);
  } catch (err) {
    // Never throws: the cron runs the digests next, and a reminder problem must not block them.
    result.failed++;
    result.error = errorDetail(err);
    log(`[notify] reminders stopped: ${result.error}`);
    return result;
  }
}

async function remind(deps: RunNotifyDeps, result: RunRemindersResult, log: (m: string) => void): Promise<RunRemindersResult> {
  const { store, slack, now } = deps;
  const ids = await store.reminderRecipients();
  if (!ids.length) return result;
  const employees = await store.employees();
  const byId = new Map(employees.map((e) => [e.id, e]));
  const previewTarget = deps.mode === "preview" ? employees.find((e) => e.email === deps.previewEmail?.trim().toLowerCase()) : undefined;
  if (deps.mode === "preview" && !previewTarget) throw new Error("SLACK_PREVIEW_EMAIL does not match an employee");

  const work: { recipient: NotifyEmployee; slackUser: SlackRecipient; reminder: DueReminder }[] = [];
  for (const id of ids) {
    const recipient = byId.get(id);
    if (!recipient || !isActiveEmployee(recipient)) continue;
    const target = previewTarget ?? recipient;
    let slackUser: SlackRecipient | null;
    try {
      slackUser = await resolveSlackUser(store, slack, target, now);
    } catch (err) {
      result.failed++;
      log(`[notify] reminder Slack lookup failed employee=${target.id}: ${errorDetail(err)}`);
      continue;
    }
    if (!slackUser) continue;
    const due = dueReminders(now, slackUser.tz, { anyTime: deps.replay });
    if (!due.length) {
      result.waiting++;
      continue;
    }
    for (const reminder of due) work.push({ recipient, slackUser, reminder });
  }
  result.due = [...new Set(work.map((w) => `${w.reminder.kind}:${w.reminder.periodKey}`))];
  if (!work.length) return result;

  const states = await store.sendStates([...new Set(work.map((w) => w.reminder.periodKey))], deps.mode);
  const handled = (w: (typeof work)[number]) =>
    states.some((s) => s.report === "reminder" && s.employeeId === w.recipient.id && s.cadence === w.reminder.cadence && s.periodKey === w.reminder.periodKey);
  const open = work.filter((w) => {
    if (!handled(w)) return true;
    result.alreadyHandled++;
    return false;
  });
  if (!open.length) return result;

  const importsUrl = `${deps.baseUrl}/data?tab=imports`;
  const weekly = open.find((w) => w.reminder.kind === "weekly");
  let weeklyMessage: RenderedDigest | null = null;
  if (weekly) {
    const at = new Date(`${weekly.reminder.day}T12:00:00Z`);
    const week = periodFor("weekly", weekly.reminder.periodKey, at);
    const lastDay = new Date(Date.parse(`${week.toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const [syncRuns, imports, personal, company, sent] = await Promise.all([
      store.recentSyncRuns(readinessSyncSince(now)),
      store.manualImports(importsInUseSince(lastDay)),
      store.subscriptions(["weekly"]),
      store.companyRecipients(["weekly"]),
      store.sendStates([week.key], deps.mode),
    ]);
    const done = new Set(sent.filter((s) => s.report !== "reminder" && (s.status === "sent" || s.status === "pending")).map((s) => `${s.employeeId}|${s.report}`));
    const waiting = [...personal.map((s) => ({ ...s, report: "personal" })), ...company.map((s) => ({ ...s, report: "company" }))].filter((s) => {
      const e = byId.get(s.employeeId);
      return e && isActiveEmployee(e) && !done.has(`${s.employeeId}|${s.report}`);
    }).length;
    let monthly: { monthName: string; missing: string[] } | null = null;
    if (inMonthlyWindow(weekly.reminder.day)) {
      const prevMonth = latestCompleteKey("monthly", at);
      const m = monthlyReadiness(await store.importCoverage(weekly.reminder.day.slice(0, 7)), prevMonth);
      if (!m.ready) monthly = { monthName: MONTHS[Number(prevMonth.slice(5, 7)) - 1], missing: m.missing.map((x) => x.label) };
    }
    weeklyMessage = weeklyReminder({ week: { label: week.label, lastDay }, outstanding: weekReadiness({ week, syncRuns, imports }).outstanding, monthly, waiting, importsUrl });
  }

  for (const w of open) {
    const base = w.reminder.kind === "weekly" ? weeklyMessage! : monthEndReminder({ monthName: MONTHS[Number(w.reminder.periodKey.slice(5, 7)) - 1], importsUrl });
    const message: RenderedDigest = previewTarget
      ? { blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: `Preview for *${w.recipient.fullName}* (update reminder)` }] }, ...base.blocks], text: `[Preview for ${w.recipient.fullName}] ${base.text}` }
      : base;
    const key: SendKey = { employeeId: w.recipient.id, cadence: w.reminder.cadence, periodKey: w.reminder.periodKey, mode: deps.mode, report: "reminder" };
    if (!(await claim(store, key, result, log))) continue;
    let posted = false;
    try {
      const ts = await deliverRendered({ slack, renderChart: deps.renderChart, slackUserId: w.slackUser.slackUserId, layouts: {}, render: () => message, log, sleep: deps.sleep });
      posted = true;
      await store.finishSend(key, { status: "sent", slackTs: ts });
      result.sent++;
    } catch (err) {
      if (posted) {
        result.sent++;
        log(`[notify] reminder sent but not recorded employee=${key.employeeId}: ${errorDetail(err)}`);
      } else if (err instanceof PostOutcomeUnknownError) {
        result.failed++; // leave pending → expires "interrupted", never retried
        log(`[notify] reminder post outcome unknown employee=${key.employeeId}: ${err.code}`);
      } else {
        result.failed++;
        log(`[notify] reminder failed employee=${key.employeeId}: ${errorDetail(err)}`);
        await store.finishSend(key, { status: "failed", detail: errorDetail(err) }).catch(() => undefined);
      }
    }
  }
  return result;
}
