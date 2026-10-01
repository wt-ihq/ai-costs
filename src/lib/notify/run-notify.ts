import { loadNotifyContext, digestFor, syncRunsSince } from "./context";
import { deliverDigest, PostOutcomeUnknownError, resolveSlackUser, type RenderChart } from "./deliver";
import { anySyncSucceededToday, monthlyReadiness } from "./freshness";
import { dueDigests, latestCompleteKey, MONTHLY_WINDOW } from "./schedule";
import { SlackApiError, type SlackClient } from "./slack-client";
import type { NotifyStore, SendKey } from "./store";
import { isActiveEmployee, type SendMode } from "./types";

export interface RunNotifyDeps {
  store: NotifyStore;
  slack: SlackClient;
  renderChart: RenderChart;
  mode: SendMode;
  previewEmail: string | null;
  now: Date; // the morning being run (?date= replays in preview)
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
  note?: string;
}

export const STALE_PENDING_MS = 10 * 60_000;
/** Stop claiming new recipients well inside the route's 300 s maxDuration. */
export const DEFAULT_BUDGET_MS = 240_000;

const errorDetail = (err: unknown) =>
  (err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * One cron run: expire interrupted claims, work out what's due, then per
 * (recipient, cadence) — isolated like runAllSyncs' sources — claim → build →
 * chart → DM → mark. A post that succeeded, or may have succeeded, is NEVER
 * followed by a retryable state, even if the DB write after it fails.
 */
export async function runNotify(deps: RunNotifyDeps): Promise<RunNotifyResult> {
  const { store, slack, now } = deps;
  const clock = deps.clock ?? Date.now;
  const log = deps.log ?? console.log;
  const start = clock();
  const budget = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const result: RunNotifyResult = { due: [], sent: 0, skipped: 0, failed: 0, alreadyHandled: 0, notReached: 0, expired: 0 };

  result.expired = await store.expireStalePending(new Date(clock() - STALE_PENDING_MS).toISOString());

  const coverage = await store.importCoverage(now.toISOString().slice(0, 7));
  let due = dueDigests(now, monthlyReadiness(coverage, latestCompleteKey("monthly", now)).ready);
  const syncRuns = await store.recentSyncRuns(syncRunsSince(now));
  if (!anySyncSucceededToday(syncRuns, now)) {
    // No all-caveat messages. A monthly waits for tomorrow — except on the window's last day.
    const kept = due.filter((d) => d.period.cadence === "monthly" && now.getUTCDate() === MONTHLY_WINDOW.lastDay);
    if (kept.length < due.length) result.note = "no source synced successfully today — daily/weekly skipped";
    due = kept;
  }
  result.due = due.map((d) => `${d.period.cadence}:${d.period.key}`);
  if (!due.length) return result;

  const subs = await store.subscriptions(due.map((d) => d.period.cadence));
  if (!subs.length) return result;

  const ctx = await loadNotifyContext(store, now, deps.baseUrl, { coverage, syncRuns });
  const previewTarget =
    deps.mode === "preview" ? ctx.employees.find((e) => e.email === deps.previewEmail?.trim().toLowerCase()) : undefined;
  if (deps.mode === "preview" && !previewTarget) throw new Error("SLACK_PREVIEW_EMAIL does not match an employee");

  const periodByCadence = new Map(due.map((d) => [d.period.cadence, d.period]));
  for (const sub of subs) {
    const period = periodByCadence.get(sub.cadence);
    const recipient = ctx.employeesById.get(sub.employeeId);
    if (!period || !recipient || !isActiveEmployee(recipient)) continue;
    if (clock() - start > budget) {
      result.notReached++;
      continue;
    }
    const key: SendKey = { employeeId: recipient.id, cadence: sub.cadence, periodKey: period.key, mode: deps.mode };

    // The claim is isolated like everything else here. A claim error means this run does not
    // own the row (or can't tell), so it must never reach finishSend for it: whatever state
    // the row is in stays as is — an orphaned pending row just expires as "interrupted".
    let claimed: boolean;
    try {
      claimed = await store.claimSend(key);
    } catch (err) {
      result.failed++;
      log(`[notify] claim failed employee=${recipient.id} cadence=${sub.cadence}: ${errorDetail(err)}`);
      continue;
    }
    if (!claimed) {
      result.alreadyHandled++;
      continue;
    }

    let posted = false;
    try {
      const digest = digestFor(ctx, recipient.id, period);
      if (!digest) {
        await store.finishSend(key, { status: "skipped", detail: "no usage" });
        result.skipped++;
        continue;
      }
      const slackUserId = await resolveSlackUser(store, slack, previewTarget ?? recipient, new Date(clock()));
      if (!slackUserId) {
        await store.finishSend(key, { status: "failed", detail: "no Slack account" });
        result.failed++;
        continue;
      }
      const ts = await deliverDigest({
        slack,
        renderChart: deps.renderChart,
        slackUserId,
        digest,
        previewFor: previewTarget ? `${recipient.fullName} (${sub.cadence})` : undefined,
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
        log(`[notify] sent but not recorded employee=${recipient.id} cadence=${sub.cadence}: ${errorDetail(err)}`);
      } else if (err instanceof PostOutcomeUnknownError) {
        // Slack may have accepted the DM. Leave the row pending (no finishSend) → the stale sweep
        // marks it "interrupted", which is never retried. Counted failed so the run is flagged.
        result.failed++;
        log(`[notify] post outcome unknown employee=${recipient.id} cadence=${sub.cadence}: ${err.code}`);
      } else {
        result.failed++;
        log(`[notify] send failed employee=${recipient.id} cadence=${sub.cadence}: ${errorDetail(err)}`);
        await store.finishSend(key, { status: "failed", detail: errorDetail(err) }).catch(() => undefined);
      }
    }
  }

  log(`[notify] mode=${deps.mode} due=${result.due.join(",")} sent=${result.sent} skipped=${result.skipped} failed=${result.failed} notReached=${result.notReached} expired=${result.expired}`);
  return result;
}
