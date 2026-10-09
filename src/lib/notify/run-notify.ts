import { loadNotifyContext, digestFor, syncRunsSince, type NotifyContext } from "./context";
import { deliverDigest, PostOutcomeUnknownError, resolveSlackUser, type RenderChart, type SlackRecipient } from "./deliver";
import { monthlyReadiness, syncSucceededSince } from "./freshness";
import { dueDigests, latestCompleteKey, MONTHLY_WINDOW, monthlyLastDay, sendDay, type DigestPeriod, type DueDigest } from "./schedule";
import { SlackApiError, type SlackClient } from "./slack-client";
import { canRetakeClaim, type NotifyStore, type SendKey } from "./store";
import { isActiveEmployee, type Cadence, type NotifyEmployee, type SendMode } from "./types";

export interface RunNotifyDeps {
  store: NotifyStore;
  slack: SlackClient;
  renderChart: RenderChart;
  mode: SendMode;
  previewEmail: string | null;
  now: Date; // the moment being run (?date= replays in preview)
  /** A ?date= replay: everyone's day is that date and nobody waits for 10:30. */
  replay?: boolean;
  baseUrl: string;
  budgetMs?: number;
  clock?: () => number; // real elapsed time (budget, stale cutoff)
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>; // pause before the image-block retry; injectable for tests
}

export interface RunNotifyResult {
  due: string[];
  sent: number;
  skipped: number;
  failed: number;
  alreadyHandled: number;
  notReached: number;
  expired: number;
  /** Subscriptions whose recipient is before 10:30, or at the weekend, where they are. */
  waiting: number;
  note?: string;
}

const CADENCES: Cadence[] = ["daily", "weekly", "monthly"];

export const STALE_PENDING_MS = 10 * 60_000;
/** Stop claiming new recipients well inside the route's 300 s maxDuration. */
export const DEFAULT_BUDGET_MS = 240_000;

const errorDetail = (err: unknown) =>
  (err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * One run (hourly at :30): expire interrupted claims; work out whose local
 * time is past 10:30 on a working day; what's due on that day; drop what's
 * already handled — all BEFORE the heavy data load, so most runs stop early —
 * then per (recipient, cadence), isolated like runAllSyncs' sources: claim →
 * build → chart → DM → mark. A post that succeeded, or may have succeeded, is
 * NEVER followed by a retryable state, even if the DB write after it fails.
 */
export async function runNotify(deps: RunNotifyDeps): Promise<RunNotifyResult> {
  const { store, slack, now } = deps;
  const clock = deps.clock ?? Date.now;
  const log = deps.log ?? console.log;
  const start = clock();
  const budget = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const result: RunNotifyResult = { due: [], sent: 0, skipped: 0, failed: 0, alreadyHandled: 0, notReached: 0, expired: 0, waiting: 0 };
  const done = () => {
    log(`[notify] mode=${deps.mode} due=${result.due.join(",")} sent=${result.sent} skipped=${result.skipped} failed=${result.failed} waiting=${result.waiting} notReached=${result.notReached} expired=${result.expired}`);
    return result;
  };

  result.expired = await store.expireStalePending(new Date(clock() - STALE_PENDING_MS).toISOString());

  const subs = await store.subscriptions(CADENCES);
  if (!subs.length) return done();
  const employees = await store.employees();
  const employeesById = new Map(employees.map((e) => [e.id, e]));
  const previewTarget = deps.mode === "preview" ? employees.find((e) => e.email === deps.previewEmail?.trim().toLowerCase()) : undefined;
  if (deps.mode === "preview" && !previewTarget) throw new Error("SLACK_PREVIEW_EMAIL does not match an employee");

  // 1. Whose day it is: the DM's recipient (in preview, the previewer) must be past 10:30 on a working day.
  const slackUsers = new Map<string, SlackRecipient | null>();
  const lookupFailed = new Set<string>();
  const candidates: { recipient: NotifyEmployee; cadence: Cadence; slackUser: SlackRecipient | null; day: string }[] = [];
  for (const sub of subs) {
    const recipient = employeesById.get(sub.employeeId);
    if (!recipient || !isActiveEmployee(recipient)) continue;
    if (clock() - start > budget) {
      result.notReached++; // nothing claimed: the next hourly run carries on from the cache
      continue;
    }
    const target = previewTarget ?? recipient;
    if (lookupFailed.has(target.id)) continue;
    if (!slackUsers.has(target.id)) {
      try {
        slackUsers.set(target.id, await resolveSlackUser(store, slack, target, new Date(clock())));
      } catch (err) {
        // Without their Slack account we can't tell their time zone: leave them, unclaimed, for the next run.
        lookupFailed.add(target.id);
        result.failed++;
        log(`[notify] Slack lookup failed employee=${target.id}: ${errorDetail(err)}`);
        continue;
      }
    }
    const slackUser = slackUsers.get(target.id) ?? null;
    const day = deps.replay ? now.toISOString().slice(0, 10) : sendDay(now, slackUser?.tz ?? null);
    if (!day) {
      result.waiting++;
      continue;
    }
    candidates.push({ recipient, cadence: sub.cadence, slackUser, day });
  }
  if (!candidates.length) return done();

  // 2. What's due on each of those days (usually one). Import coverage pages through every manual-source
  //    fact, so it's read only when a monthly could be due.
  const days = [...new Set(candidates.map((c) => c.day))];
  const inMonthlyWindow = (day: string) => Number(day.slice(8, 10)) >= MONTHLY_WINDOW.firstDay && Number(day.slice(8, 10)) <= monthlyLastDay(day.slice(0, 7));
  const coverage = days.some(inMonthlyWindow) ? await store.importCoverage(now.toISOString().slice(0, 7)) : [];
  const syncRuns = await store.recentSyncRuns(syncRunsSince(now));
  const dueByDay = new Map<string, DueDigest[]>();
  for (const day of days) {
    const prevMonth = latestCompleteKey("monthly", new Date(`${day}T12:00:00Z`));
    let due = dueDigests(day, inMonthlyWindow(day) && monthlyReadiness(coverage, prevMonth).ready);
    if (!syncSucceededSince(syncRuns, day)) {
      // No all-caveat messages. A monthly waits for a later run — except on the window's last day.
      const kept = due.filter((d) => d.period.cadence === "monthly" && Number(day.slice(8, 10)) === monthlyLastDay(day.slice(0, 7)));
      if (kept.length < due.length) result.note = `no source has synced since ${day} began — daily/weekly held`;
      due = kept;
    }
    dueByDay.set(day, due);
  }
  result.due = [...new Set([...dueByDay.values()].flat().map((d) => `${d.period.cadence}:${d.period.key}`))];

  const work = candidates.flatMap((c) => {
    const due = dueByDay.get(c.day)!.find((d) => d.period.cadence === c.cadence);
    return due ? [{ ...c, period: due.period }] : [];
  });

  // 3. Drop what's already handled, so a run with nothing left to send never loads the spend data.
  //    A missing Slack account isn't retried: Slack's answer is cached for a week.
  const states = await store.sendStates([...new Set(work.map((w) => w.period.key))], deps.mode);
  const open = work.filter((w) => {
    const row = states.find((s) => s.employeeId === w.recipient.id && s.cadence === w.cadence && s.periodKey === w.period.key);
    return !row || (w.slackUser !== null && canRetakeClaim(row));
  });
  result.alreadyHandled += work.length - open.length;

  // No Slack account: log it without loading any spend data.
  for (const w of open.filter((o) => !o.slackUser)) {
    const key = sendKey(deps, w);
    if (!(await claim(store, key, result, log))) continue;
    await store.finishSend(key, { status: "failed", detail: "no Slack account" }).catch(() => undefined);
    result.failed++;
  }
  const sendable = open.filter((o): o is typeof o & { slackUser: SlackRecipient } => o.slackUser !== null);
  if (!sendable.length) return done();

  const ctx = await loadNotifyContext(store, now, deps.baseUrl, { coverage, syncRuns, employees });
  for (const w of sendable) {
    if (clock() - start > budget) {
      result.notReached++;
      continue;
    }
    await sendOne(deps, w, ctx, result, { log, previewTarget });
  }
  return done();
}

const sendKey = (deps: RunNotifyDeps, w: { recipient: NotifyEmployee; cadence: Cadence; period: DigestPeriod }): SendKey => ({
  employeeId: w.recipient.id,
  cadence: w.cadence,
  periodKey: w.period.key,
  mode: deps.mode,
});

/**
 * Claim the send row; its id when ours, null when not (already handled, or the claim errored). A claim
 * error means this run does not own the row (or can't tell), so it must never reach finishSend for it:
 * whatever state the row is in stays as is — an orphaned pending row just expires as "interrupted".
 */
async function claim(store: NotifyStore, key: SendKey, result: RunNotifyResult, log: (m: string) => void): Promise<string | null> {
  try {
    const id = await store.claimSend(key);
    if (id) return id;
    result.alreadyHandled++;
  } catch (err) {
    result.failed++;
    log(`[notify] claim failed employee=${key.employeeId} cadence=${key.cadence}: ${errorDetail(err)}`);
  }
  return null;
}

/** One (recipient, cadence): claim → build → DM → mark, with every failure contained here. */
async function sendOne(
  deps: RunNotifyDeps,
  w: { recipient: NotifyEmployee; cadence: Cadence; slackUser: SlackRecipient; period: DigestPeriod },
  ctx: NotifyContext,
  result: RunNotifyResult,
  { log, previewTarget }: { log: (m: string) => void; previewTarget: NotifyEmployee | undefined },
): Promise<void> {
  const { store, slack } = deps;
  const { recipient, cadence, period } = w;
  const key = sendKey(deps, w);
  const sendId = await claim(store, key, result, log);
  if (!sendId) return;

  let posted = false;
  try {
    const digest = digestFor(ctx, recipient.id, period);
    if (!digest) {
      await store.finishSend(key, { status: "skipped", detail: "no usage" });
      result.skipped++;
      return;
    }
    const ts = await deliverDigest({
      slack,
      renderChart: deps.renderChart,
      slackUserId: w.slackUser.slackUserId,
      digest,
      previewFor: previewTarget ? `${recipient.fullName} (${cadence})` : undefined,
      openUrl: `${deps.baseUrl}/api/digest/open/${sendId}`,
      log,
      sleep: deps.sleep,
    });
    posted = true;
    await store.finishSend(key, { status: "sent", slackTs: ts });
    result.sent++;
  } catch (err) {
    if (posted) {
      // The DM went out; leave the row pending → it expires as "interrupted" and is never retried.
      result.sent++;
      log(`[notify] sent but not recorded employee=${recipient.id} cadence=${cadence}: ${errorDetail(err)}`);
    } else if (err instanceof PostOutcomeUnknownError) {
      // Slack may have accepted the DM. Leave the row pending (no finishSend) → the stale sweep
      // marks it "interrupted", which is never retried. Counted failed so the run is flagged.
      result.failed++;
      log(`[notify] post outcome unknown employee=${recipient.id} cadence=${cadence}: ${err.code}`);
    } else {
      result.failed++;
      log(`[notify] send failed employee=${recipient.id} cadence=${cadence}: ${errorDetail(err)}`);
      await store.finishSend(key, { status: "failed", detail: errorDetail(err) }).catch(() => undefined);
    }
  }
}
