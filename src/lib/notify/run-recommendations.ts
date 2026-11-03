import type { RecommendationsData } from "@/lib/recommendations/load";
import { deliverRendered, loadDashboardAccess, PostOutcomeUnknownError, resolveSlackUser, type SlackRecipient } from "./deliver";
import { importsInUseSince, outstandingShort, readinessSyncSince, recommendationsReadiness } from "./readiness";
import { renderRecommendations } from "./render-recommendations";
import { claim, errorDetail, type RunNotifyDeps } from "./run-notify";
import { latestCompleteKey, periodFor, sendDay, type DigestPeriod } from "./schedule";
import { canRetakeClaim, type SendKey } from "./store";
import { isActiveEmployee, type NotifyEmployee } from "./types";

export interface RecommendationsRunDeps extends Omit<RunNotifyDeps, "only"> {
  // renderChart stays: deliverRendered takes it, and with empty layouts never calls it.
  loadData: (now: Date) => Promise<RecommendationsData>; // cron: (now) => loadRecommendations(supabase, now)
  /** Send now: this week only, today for everyone, optionally forced past readiness or limited to these people. */
  only?: { periodKey: string; force?: boolean; employeeIds?: string[] };
}

export interface RunRecommendationsResult {
  periodKey: string | null;
  sent: number;
  failed: number;
  alreadyHandled: number;
  waiting: number; // recipients before 10:30, or at the weekend, where they are
  /** Why nothing was claimed: the week's outstanding data ("Claude Team (pasted as of 1 Nov) · Cursor sync") or "data window mismatch". */
  held: string | null;
  /** The run stopped early (e.g. the loader failed); the digests still run after it. */
  error?: string;
}

const DAY_MS = 86_400_000;
const lastDayOf = (p: DigestPeriod) => new Date(Date.parse(`${p.toExclusive}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/**
 * The weekly Premium seat recommendations DM: due any working day from 10:30 in each recipient's
 * time zone once the latest complete week is ready, claimed in notification_sends (report
 * "recommendations") — never twice. Separate from runNotify, whose `only` has no report dimension, so
 * its Send now, catch-up and Live test never fire this. Cheap: nothing is loaded unless someone is due.
 */
export async function runRecommendations(deps: RecommendationsRunDeps): Promise<RunRecommendationsResult> {
  const log = deps.log ?? console.log;
  const result: RunRecommendationsResult = { periodKey: null, sent: 0, failed: 0, alreadyHandled: 0, waiting: 0, held: null };
  try {
    return await recommend(deps, result, log);
  } catch (err) {
    // Never throws: the cron runs the digests next, and a recommendations problem must not block them.
    result.failed++;
    result.error = errorDetail(err);
    log(`[notify] recommendations stopped: ${result.error}`);
    return result;
  }
}

async function recommend(deps: RecommendationsRunDeps, result: RunRecommendationsResult, log: (m: string) => void): Promise<RunRecommendationsResult> {
  const { store, slack, now, only } = deps;
  const ids = (await store.recommendationRecipients()).filter((id) => !only?.employeeIds || only.employeeIds.includes(id));
  if (!ids.length) return result;
  const employees = await store.employees();
  const byId = new Map(employees.map((e) => [e.id, e]));
  const previewTarget = deps.mode === "preview" ? employees.find((e) => e.email === deps.previewEmail?.trim().toLowerCase()) : undefined;
  if (deps.mode === "preview" && !previewTarget) throw new Error("SLACK_PREVIEW_EMAIL does not match an employee");

  // 1. Whose day it is: the DM's recipient (in preview, the previewer) past 10:30 on a working day.
  const today = now.toISOString().slice(0, 10);
  const work: { recipient: NotifyEmployee; slackUser: SlackRecipient; period: DigestPeriod }[] = [];
  for (const id of ids) {
    const recipient = byId.get(id);
    if (!recipient || !isActiveEmployee(recipient)) continue;
    const target = previewTarget ?? recipient;
    let slackUser: SlackRecipient | null;
    try {
      slackUser = await resolveSlackUser(store, slack, target, now);
    } catch (err) {
      result.failed++;
      log(`[notify] recommendations Slack lookup failed employee=${target.id}: ${errorDetail(err)}`);
      continue;
    }
    if (!slackUser) continue;
    const day = deps.replay || only ? today : sendDay(now, slackUser.tz);
    if (!day) {
      result.waiting++;
      continue;
    }
    const at = new Date(`${day}T12:00:00Z`);
    work.push({ recipient, slackUser, period: periodFor("weekly", only?.periodKey ?? latestCompleteKey("weekly", at), at) });
  }
  if (!work.length) return result;
  result.periodKey = work[0].period.key;

  // 2. Drop what's already handled, BEFORE loading: the cron fires 24×/day.
  const states = await store.sendStates([...new Set(work.map((w) => w.period.key))], deps.mode);
  const open = work.filter((w) => {
    const row = states.find((s) => s.report === "recommendations" && s.employeeId === w.recipient.id && s.cadence === "weekly" && s.periodKey === w.period.key);
    if (!row || canRetakeClaim(row)) return true;
    result.alreadyHandled++;
    return false;
  });
  if (!open.length) return result;

  // 3. Is the week ready? Two small reads, BEFORE the heavy load: an unready week is held all day,
  //    and the cron fires 24×/day. One period is checked: recipients due in the same run share the
  //    week, and if they ever didn't, the data-window guard below holds the run.
  const period = open[0].period;
  if (!only?.force) {
    const [syncRuns, imports] = await Promise.all([
      store.recentSyncRuns(readinessSyncSince(now)),
      store.manualImports(importsInUseSince(lastDayOf(period))),
    ]);
    const readiness = recommendationsReadiness({ week: { from: period.from, toExclusive: period.toExclusive }, syncRuns, imports });
    if (!readiness.ready) {
      result.held = readiness.outstanding.map(outstandingShort).join(" · ");
      log(`[notify] recommendations held week=${result.periodKey}: ${result.held}`);
      return result;
    }
  }

  // 4. The data, once. It serves only the week ending the Sunday before `now` (a ?date= replay or a
  //    Send now for an older week can't be).
  const data = await deps.loadData(now);
  if (open.some((w) => lastDayOf(w.period) !== data.sunday)) {
    result.held = "data window mismatch";
    log(`[notify] recommendations held week=${result.periodKey}: data is for the week to ${data.sunday}`);
    return result;
  }

  const canOpenDashboard = await loadDashboardAccess(store, deps.adminEmails, log);
  const dashboardUrl = `${deps.baseUrl}/recommendations`;
  for (const w of open) {
    const key: SendKey = { employeeId: w.recipient.id, cadence: "weekly", periodKey: w.period.key, mode: deps.mode, report: "recommendations" };
    const sendId = await claim(store, key, result, log);
    if (!sendId) continue;
    // Decided by the person it's for — in preview too, so the preview shows what they would get.
    const links = canOpenDashboard(w.recipient.email);
    const render = () =>
      renderRecommendations({ data, dashboardUrl, openUrl: `${deps.baseUrl}/api/digest/open/${sendId}`, links, previewFor: previewTarget ? w.recipient.fullName : undefined });
    let posted = false;
    try {
      const ts = await deliverRendered({ slack, renderChart: deps.renderChart, slackUserId: w.slackUser.slackUserId, layouts: {}, render, log, sleep: deps.sleep });
      posted = true;
      await store.finishSend(key, { status: "sent", slackTs: ts, dashboardLink: links });
      result.sent++;
    } catch (err) {
      if (posted) {
        result.sent++;
        log(`[notify] recommendations sent but not recorded employee=${key.employeeId}: ${errorDetail(err)}`);
      } else if (err instanceof PostOutcomeUnknownError) {
        result.failed++; // leave pending → expires "interrupted", never retried
        log(`[notify] recommendations post outcome unknown employee=${key.employeeId}: ${err.code}`);
      } else {
        result.failed++;
        log(`[notify] recommendations failed employee=${key.employeeId}: ${errorDetail(err)}`);
        await store.finishSend(key, { status: "failed", detail: errorDetail(err) }).catch(() => undefined);
      }
    }
  }
  return result;
}
