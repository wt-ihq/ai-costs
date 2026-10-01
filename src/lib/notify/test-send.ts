import { digestFor, loadNotifyContext, teamDigestFor } from "./context";
import { isTeamDigest } from "./digest";
import { deliverDigest, deliverTeamDigest, resolveSlackUser, type RenderChart } from "./deliver";
import { periodFor } from "./schedule";
import type { SlackClient } from "./slack-client";
import type { TestSubject, TestTarget } from "./subject";
import type { NotifyStore } from "./store";
import { activeDepartments, isActiveEmployee, isCadence, isUuid, type Cadence, type NotifyEmployee } from "./types";

export type TestSendResult = { ok: true; sentTo: string } | { ok: false; error: string };

export interface TestSendDeps {
  store: NotifyStore;
  slack: SlackClient;
  renderChart: RenderChart;
  now: Date;
  baseUrl: string;
  actorEmail: string; // the signed-in admin
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const fail = (error: string): TestSendResult => ({ ok: false, error });
const NOT_ACTIVE = "That person isn't an active employee";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseSubject(v: unknown): TestSubject | null {
  if (!isRecord(v)) return null;
  if (v.kind === "person" && isUuid(v.employeeId)) return { kind: "person", employeeId: v.employeeId };
  if (v.kind === "team" && typeof v.department === "string" && v.department.length > 0) return { kind: "team", department: v.department };
  return null;
}

function parseTarget(v: unknown): TestTarget | null {
  if (!isRecord(v)) return null;
  if (v.kind === "me" || v.kind === "subject") return { kind: v.kind };
  if (v.kind === "employee" && isUuid(v.employeeId)) return { kind: "employee", employeeId: v.employeeId };
  return null;
}

/** Every test DM says it is a test. To the subject themself there is nothing to name; to anyone else, say whose digest it is. */
export function testBanner(a: { adminName: string; subjectName: string; cadence: Cadence; toSubject: boolean }): string {
  return a.toSubject
    ? `🧪 Test message from ${a.adminName} — not a scheduled digest`
    : `🧪 Test: ${a.subjectName}'s ${a.cadence} digest, sent to you by ${a.adminName}`;
}

/**
 * An admin's explicit test: build the digest of any person or team and DM it to a chosen ACTIVE
 * employee, in any SLACK_NOTIFY_MODE. It never touches notification_sends — a test must not block
 * or duplicate the scheduled send. Inputs come from a public POST endpoint, so everything is
 * re-validated here. Logs carry ids only, never names or amounts.
 */
export async function sendTest(deps: TestSendDeps, input: { subject: unknown; cadence: unknown; periodKey: unknown; to: unknown }): Promise<TestSendResult> {
  const subject = parseSubject(input.subject);
  const to = parseTarget(input.to);
  const { cadence, periodKey } = input;
  if (!subject || !to || !isCadence(cadence) || typeof periodKey !== "string") return fail("Invalid input");
  if (subject.kind === "team" && to.kind === "subject") return fail("A team can't receive its own digest: pick yourself or someone else");

  let period;
  try {
    period = periodFor(cadence, periodKey, deps.now);
  } catch {
    return fail("Invalid period");
  }

  try {
    const log = deps.log ?? console.log;
    const ctx = await loadNotifyContext(deps.store, deps.now, deps.baseUrl, { earliest: period.buckets[0].from });
    const admin = ctx.employees.find((e) => e.email === deps.actorEmail.toLowerCase());
    const adminName = admin?.fullName ?? deps.actorEmail;

    let subjectName: string;
    let subjectId: string | null = null;
    if (subject.kind === "person") {
      const s = ctx.employeesById.get(subject.employeeId);
      if (!s) return fail("Unknown person");
      subjectName = s.fullName;
      subjectId = s.id;
    } else {
      if (!activeDepartments(ctx.employees).includes(subject.department)) return fail("Unknown team");
      subjectName = subject.department;
    }

    let target: NotifyEmployee | undefined;
    if (to.kind === "me") {
      target = admin;
      if (!target) return fail("Your email isn't in the employee list");
    } else {
      target = ctx.employeesById.get(to.kind === "subject" ? (subjectId as string) : to.employeeId);
    }
    if (!target || !isActiveEmployee(target)) return fail(NOT_ACTIVE);

    const digest = subject.kind === "person" ? digestFor(ctx, subject.employeeId, period) : teamDigestFor(ctx, subject.department, period);
    if (!digest) return fail("Nothing to send for that period (no usage)");

    const slackUserId = await resolveSlackUser(deps.store, deps.slack, target, deps.now);
    if (!slackUserId) return fail(`No Slack account found for ${target.fullName}`);

    const banner = testBanner({ adminName, subjectName, cadence, toSubject: subjectId !== null && target.id === subjectId });
    const send = { slack: deps.slack, renderChart: deps.renderChart, slackUserId, banner, log: deps.log, sleep: deps.sleep };
    if (isTeamDigest(digest)) await deliverTeamDigest({ ...send, digest });
    else await deliverDigest({ ...send, digest });

    log(`[notify] test send subject=${subject.kind === "person" ? `person:${subject.employeeId}` : `team:${subject.department}`} target=${target.id} cadence=${cadence}`);
    return { ok: true, sentTo: target.fullName };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
