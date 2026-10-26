import { companyDigestFor, digestFor, loadNotifyContext, type NotifyContext } from "./context";
import { deliverCompanyDigest, deliverDigest, loadDashboardAccess, PostOutcomeUnknownError, resolveSlackUser, type RenderBanner, type RenderChart, type SlackRecipient } from "./deliver";
import type { CompanyDigest } from "./digest";
import { monthlyReadiness, syncSucceededSince } from "./freshness";
import { importsInUseSince, readinessSyncSince, syncsOutstanding, weekReadiness } from "./readiness";
import { dueDigests, inMonthlyWindow, latestCompleteKey, periodFor, sendDay, type DigestPeriod, type DueDigest } from "./schedule";
import { firstName } from "./intro";
import type { RenderOpts } from "./render";
import { SlackApiError, type SlackClient } from "./slack-client";
import { canRetakeClaim, type NotifyStore, type SendKey } from "./store";
import { isActiveEmployee, type Cadence, type NotifyEmployee, type ReportKind, type SendMode } from "./types";

export interface RunNotifyDeps {
  store: NotifyStore;
  slack: SlackClient;
  renderChart: RenderChart;
  /** The welcome banner for a first message (absent: the intro is text only). */
  renderBanner?: RenderBanner;
  mode: SendMode;
  previewEmail: string | null;
  now: Date; // the moment being run (?date= replays in preview)
  /** A ?date= replay: everyone's day is that date and nobody waits for 10:30. */
  replay?: boolean;
  /**
   * Send one digest now (Data → Notifications "Send now" / catch-up on add): this cadence and period
   * only, today is the send day for everyone (no 10:30 wait, weekends included), the weekly optionally
   * forced past its readiness hold (a monthly never is), optionally limited to these people. The claim
   * key is unchanged, so the hourly run then finds it handled.
   */
  only?: { cadence: Cadence; periodKey: string; force?: boolean; employeeIds?: string[] };
  baseUrl: string;
  /** ADMIN_EMAILS: with the access list, who gets the dashboard button and links. */
  adminEmails: readonly string[];
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
  /** Weeklies/monthlies someone is waiting for whose data isn't complete yet ("weekly:2026-W42"). */
  held: string[];
  note?: string;
  /** One line per (recipient, report) this run considered — what happened to each. */
  people: PersonOutcome[];
}

export interface PersonOutcome {
  employeeId: string;
  report: ReportKind;
  status: "sent" | "skipped" | "failed" | "alreadyHandled" | "notReached";
  detail?: string;
}

const CADENCES: Cadence[] = ["daily", "weekly", "monthly"];

export const STALE_PENDING_MS = 10 * 60_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Stop claiming new recipients well inside the route's 300 s maxDuration. */
export const DEFAULT_BUDGET_MS = 240_000;

export const errorDetail = (err: unknown) =>
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
  const result: RunNotifyResult = { due: [], sent: 0, skipped: 0, failed: 0, alreadyHandled: 0, notReached: 0, expired: 0, waiting: 0, held: [], people: [] };
  const only = deps.only;
  const note = (w: { recipient: NotifyEmployee; report: ReportKind }, status: PersonOutcome["status"], detail?: string) =>
    result.people.push(detail ? { employeeId: w.recipient.id, report: w.report, status, detail } : { employeeId: w.recipient.id, report: w.report, status });
  const done = () => {
    log(`[notify] mode=${deps.mode} due=${result.due.join(",")} sent=${result.sent} skipped=${result.skipped} failed=${result.failed} waiting=${result.waiting} held=${result.held.join(",")} notReached=${result.notReached} expired=${result.expired}`);
    return result;
  };

  result.expired = await store.expireStalePending(new Date(clock() - STALE_PENDING_MS).toISOString());

  // Both lists, each (person, cadence) tagged with its DM: someone on both gets two messages.
  const [personal, company] = await Promise.all([store.subscriptions(CADENCES), store.companyRecipients(CADENCES)]);
  const subs: { employeeId: string; cadence: Cadence; report: ReportKind }[] = [
    ...personal.map((s) => ({ ...s, report: "personal" as const })),
    ...company.map((s) => ({ ...s, report: "company" as const })),
  ].filter((s) => !only || (s.cadence === only.cadence && (!only.employeeIds || only.employeeIds.includes(s.employeeId))));
  if (!subs.length) return done();
  const employees = await store.employees();
  const employeesById = new Map(employees.map((e) => [e.id, e]));
  const previewTarget = deps.mode === "preview" ? employees.find((e) => e.email === deps.previewEmail?.trim().toLowerCase()) : undefined;
  if (deps.mode === "preview" && !previewTarget) throw new Error("SLACK_PREVIEW_EMAIL does not match an employee");

  // 1. Whose day it is: the DM's recipient (in preview, the previewer) must be past 10:30 on a working day.
  const slackUsers = new Map<string, SlackRecipient | null>();
  const lookupFailed = new Set<string>();
  const candidates: { recipient: NotifyEmployee; cadence: Cadence; report: ReportKind; slackUser: SlackRecipient | null; day: string }[] = [];
  for (const sub of subs) {
    const recipient = employeesById.get(sub.employeeId);
    if (!recipient || !isActiveEmployee(recipient)) continue;
    if (clock() - start > budget) {
      result.notReached++; // nothing claimed: the next hourly run carries on from the cache
      note({ recipient, report: sub.report }, "notReached");
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
    const day = deps.replay || only ? now.toISOString().slice(0, 10) : sendDay(now, slackUser?.tz ?? null);
    if (!day) {
      result.waiting++;
      continue;
    }
    candidates.push({ recipient, cadence: sub.cadence, report: sub.report, slackUser, day });
  }
  if (!candidates.length) return done();

  // 2. What's due on each of those days. Weeklies and monthlies go only once their data is complete
  //    (readiness.ts); a daily still waits for that day's sync. Import coverage pages through every
  //    manual-source fact, so it's read only when someone's monthly could be due.
  const days = [...new Set(candidates.map((c) => c.day))].sort();
  const wants = (day: string, cadence: Cadence) => candidates.some((c) => c.day === day && c.cadence === cadence);
  // A monthly is due from the 3rd to month end, so check who still needs it BEFORE reading import
  // coverage: once it's gone out, the rest of the month's hourly runs stay cheap.
  const monthKeyOn = (day: string) => latestCompleteKey("monthly", new Date(`${day}T12:00:00Z`));
  const monthlyCands = candidates.filter((c) => c.cadence === "monthly" && (only || inMonthlyWindow(c.day)));
  const monthlyStates = monthlyCands.length ? await store.sendStates([...new Set(monthlyCands.map((c) => monthKeyOn(c.day)))], deps.mode) : [];
  const monthlyOpen = (c: (typeof candidates)[number]) => {
    const row = monthlyStates.find((s) => s.employeeId === c.recipient.id && s.cadence === "monthly" && s.periodKey === monthKeyOn(c.day) && s.report === c.report);
    return !row || (c.slackUser !== null && canRetakeClaim(row));
  };
  const monthlyHandled = monthlyCands.filter((c) => !monthlyOpen(c)).length;
  const wantsMonthly = (day: string) => monthlyCands.some((c) => c.day === day && monthlyOpen(c));
  const coverage = days.some(wantsMonthly) ? await store.importCoverage(now.toISOString().slice(0, 7)) : [];
  const syncRuns = await store.recentSyncRuns(readinessSyncSince(now));
  const imports = days.some((d) => wants(d, "weekly")) ? await store.manualImports(importsInUseSince(addDays(days[0], -7))) : [];
  const dueByDay = new Map<string, DueDigest[]>();
  for (const day of days) {
    const at = new Date(`${day}T12:00:00Z`);
    // The named period for a send-now; the latest complete one for the schedule.
    const week = periodFor("weekly", only?.cadence === "weekly" ? only.periodKey : latestCompleteKey("weekly", at), at);
    const prevMonth = only?.cadence === "monthly" ? only.periodKey : latestCompleteKey("monthly", at);
    const weekReady = wants(day, "weekly") && (weekReadiness({ week, syncRuns, imports }).ready || (only?.force ?? false));
    const monthReady = wantsMonthly(day) && monthlyReadiness(coverage, prevMonth).ready && syncsOutstanding(syncRuns, `${day.slice(0, 7)}-01`).length === 0;
    if (wants(day, "weekly") && !weekReady) result.held.push(`weekly:${week.key}`);
    if (wantsMonthly(day) && !monthReady) result.held.push(`monthly:${prevMonth}`);
    if (only) {
      // Send now: just the named digest, if it may go — never the day's daily, no working-day rule.
      const ready = only.cadence === "weekly" ? weekReady : only.cadence === "monthly" ? monthReady : true;
      dueByDay.set(day, ready ? [{ period: periodFor(only.cadence, only.periodKey, at) }] : []);
      continue;
    }
    let due = dueDigests(day, { week: weekReady, month: monthReady });
    if (!syncSucceededSince(syncRuns, day)) {
      // The daily covers yesterday: it waits for today's sync. Weeklies/monthlies have their own check.
      const kept = due.filter((d) => d.period.cadence !== "daily");
      if (kept.length < due.length) result.note = `no source has synced since ${day} began — daily held`;
      due = kept;
    }
    dueByDay.set(day, due);
  }
  result.held = [...new Set(result.held)];
  result.due = [...new Set([...dueByDay.values()].flat().map((d) => `${d.period.cadence}:${d.period.key}`))];

  // Monthlies already handled were counted above; leave them out so step 3 doesn't count them again.
  const work = candidates.filter((c) => !(c.cadence === "monthly" && monthlyCands.includes(c) && !monthlyOpen(c))).flatMap((c) => {
    const due = dueByDay.get(c.day)!.find((d) => d.period.cadence === c.cadence);
    return due ? [{ ...c, period: due.period }] : [];
  });

  result.alreadyHandled += monthlyHandled; // sent monthlies, found before the coverage read
  for (const c of monthlyCands.filter((c) => !monthlyOpen(c))) note(c, "alreadyHandled");

  // 3. Drop what's already handled, so a run with nothing left to send never loads the spend data.
  //    A missing Slack account isn't retried: Slack's answer is cached for a week.
  const states = await store.sendStates([...new Set(work.map((w) => w.period.key))], deps.mode);
  const open = work.filter((w) => {
    const row = states.find((s) => s.employeeId === w.recipient.id && s.cadence === w.cadence && s.periodKey === w.period.key && s.report === w.report);
    if (!row || (w.slackUser !== null && canRetakeClaim(row))) return true;
    note(w, "alreadyHandled");
    return false;
  });
  result.alreadyHandled += work.length - open.length;

  // No Slack account: log it without loading any spend data.
  for (const w of open.filter((o) => !o.slackUser)) {
    const key = sendKey(deps, w);
    const before = { handled: result.alreadyHandled, failed: result.failed };
    if (!(await claim(store, key, result, log))) {
      note(w, result.failed > before.failed ? "failed" : "alreadyHandled", result.failed > before.failed ? "claim failed" : undefined);
      continue;
    }
    await store.finishSend(key, { status: "failed", detail: "no Slack account" }).catch(() => undefined);
    result.failed++;
    note(w, "failed", "no Slack account");
  }
  const sendable = open.filter((o): o is typeof o & { slackUser: SlackRecipient } => o.slackUser !== null);
  if (!sendable.length) return done();

  const ctx = await loadNotifyContext(store, now, deps.baseUrl, { coverage, syncRuns, employees });
  const canOpenDashboard = await loadDashboardAccess(store, deps.adminEmails, log);
  // A person's first live message opens with the intro (intro.ts). Unsure who's had one → nobody gets
  // it: a missed welcome beats a second one.
  let hadLive: ReadonlySet<string>;
  try {
    hadLive = await store.everLive([...new Set(sendable.map((w) => w.recipient.id))]);
  } catch (err) {
    log(`[notify] send history unreadable, no intros this run: ${errorDetail(err)}`);
    hadLive = new Set(sendable.map((w) => w.recipient.id));
  }
  const cadencesOf: Record<ReportKind, Map<string, Cadence[]>> = { personal: byPerson(personal), company: byPerson(company) };
  const intros: IntroState = { hadLive, introduced: new Set(), cadencesOf };
  const companyDigests = new Map<string, CompanyDigest | null>(); // by period key: built once per period per run
  for (const w of sendable) {
    if (clock() - start > budget) {
      result.notReached++;
      note(w, "notReached");
      continue;
    }
    await sendOne(deps, w, ctx, result, { log, previewTarget, companyDigests, canOpenDashboard, intros, note });
  }
  return done();
}

const byPerson = (rows: { employeeId: string; cadence: Cadence }[]) => {
  const m = new Map<string, Cadence[]>();
  for (const r of rows) m.set(r.employeeId, [...(m.get(r.employeeId) ?? []), r.cadence]);
  return m;
};

/** Who gets the first-message intro: no live message before, and not already given one this run. */
interface IntroState {
  hadLive: ReadonlySet<string>;
  introduced: Set<string>;
  cadencesOf: Record<ReportKind, Map<string, Cadence[]>>;
}

/** The intro for this DM, or undefined; claims it, so a person on both lists gets one (the personal summary runs first). */
function takeIntro(s: IntroState, recipient: NotifyEmployee, report: ReportKind, cadence: Cadence): RenderOpts["intro"] {
  if (s.hadLive.has(recipient.id) || s.introduced.has(recipient.id)) return undefined;
  s.introduced.add(recipient.id);
  return { name: firstName(recipient.fullName), cadences: s.cadencesOf[report].get(recipient.id) ?? [cadence] };
}

const sendKey = (deps: RunNotifyDeps, w: { recipient: NotifyEmployee; cadence: Cadence; report: ReportKind; period: DigestPeriod }): SendKey => ({
  employeeId: w.recipient.id,
  cadence: w.cadence,
  periodKey: w.period.key,
  mode: deps.mode,
  report: w.report,
});

/** A send's ids for a log line. Personal sends keep their established shape; company ones say so. */
const who = (k: SendKey) => `employee=${k.employeeId} cadence=${k.cadence}${k.report !== "personal" ? ` report=${k.report}` : ""}`;

/**
 * Claim the send row; its id when ours, null when not (already handled, or the claim errored). A claim
 * error means this run does not own the row (or can't tell), so it must never reach finishSend for it:
 * whatever state the row is in stays as is — an orphaned pending row just expires as "interrupted".
 */
export async function claim(store: NotifyStore, key: SendKey, result: { alreadyHandled: number; failed: number }, log: (m: string) => void): Promise<string | null> {
  try {
    const id = await store.claimSend(key);
    if (id) return id;
    result.alreadyHandled++;
  } catch (err) {
    result.failed++;
    log(`[notify] claim failed ${who(key)}: ${errorDetail(err)}`);
  }
  return null;
}

/** One (recipient, cadence, report): claim → build → DM → mark, with every failure contained here. */
async function sendOne(
  deps: RunNotifyDeps,
  w: { recipient: NotifyEmployee; cadence: Cadence; report: ReportKind; slackUser: SlackRecipient; period: DigestPeriod },
  ctx: NotifyContext,
  result: RunNotifyResult,
  { log, previewTarget, companyDigests, canOpenDashboard, intros, note }: {
    log: (m: string) => void;
    previewTarget: NotifyEmployee | undefined;
    companyDigests: Map<string, CompanyDigest | null>;
    canOpenDashboard: (email: string) => boolean;
    intros: IntroState;
    note: (w: { recipient: NotifyEmployee; report: ReportKind }, status: PersonOutcome["status"], detail?: string) => void;
  },
): Promise<void> {
  const { store, slack } = deps;
  const { recipient, cadence, period } = w;
  const key = sendKey(deps, w);
  const before = { failed: result.failed };
  const sendId = await claim(store, key, result, log);
  if (!sendId) {
    note(w, result.failed > before.failed ? "failed" : "alreadyHandled", result.failed > before.failed ? "claim failed" : undefined);
    return;
  }

  const skip = async () => {
    await store.finishSend(key, { status: "skipped", detail: "no usage" });
    result.skipped++;
    note(w, "skipped", "no usage");
  };
  // Decided by the person it's for — in preview too, so the preview shows what they would get.
  const links = canOpenDashboard(recipient.email);
  const common = {
    slack,
    renderChart: deps.renderChart,
    renderBanner: deps.renderBanner,
    slackUserId: w.slackUser.slackUserId,
    links,
    openUrl: `${deps.baseUrl}/api/digest/open/${sendId}`,
    log,
    sleep: deps.sleep,
  };
  let posted = false;
  try {
    let ts: string;
    if (w.report === "company") {
      // The same report for everyone it is due to.
      let digest = companyDigests.get(period.key);
      if (digest === undefined) {
        digest = companyDigestFor(ctx, period);
        companyDigests.set(period.key, digest);
      }
      if (!digest) return await skip();
      const intro = takeIntro(intros, recipient, "company", cadence);
      ts = await deliverCompanyDigest({ ...common, digest, intro, previewFor: previewTarget ? `${recipient.fullName} (company ${cadence})` : undefined });
    } else {
      const digest = digestFor(ctx, recipient.id, period);
      if (!digest) return await skip();
      const intro = takeIntro(intros, recipient, "personal", cadence);
      ts = await deliverDigest({ ...common, digest, intro, previewFor: previewTarget ? `${recipient.fullName} (${cadence})` : undefined });
    }
    posted = true;
    await store.finishSend(key, { status: "sent", slackTs: ts, dashboardLink: links });
    result.sent++;
    note(w, "sent");
  } catch (err) {
    if (posted) {
      // The DM went out; leave the row pending → it expires as "interrupted" and is never retried.
      result.sent++;
      note(w, "sent");
      log(`[notify] sent but not recorded ${who(key)}: ${errorDetail(err)}`);
    } else if (err instanceof PostOutcomeUnknownError) {
      // Slack may have accepted the DM. Leave the row pending (no finishSend) → the stale sweep
      // marks it "interrupted", which is never retried. Counted failed so the run is flagged.
      result.failed++;
      note(w, "failed", `Slack ${err.code}: outcome unknown`);
      log(`[notify] post outcome unknown ${who(key)}: ${err.code}`);
    } else {
      result.failed++;
      note(w, "failed", errorDetail(err));
      log(`[notify] send failed ${who(key)}: ${errorDetail(err)}`);
      await store.finishSend(key, { status: "failed", detail: errorDetail(err) }).catch(() => undefined);
    }
  }
}
