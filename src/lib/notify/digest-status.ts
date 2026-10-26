import { isWorkingDay, type DigestPeriod } from "./schedule";
import type { NotifyMode } from "./types";

/**
 * Data → Notifications' digests table: one row per weekly / monthly digest in play — what it's
 * waiting for, when it goes out by itself, who it went to — and the Send now button's words. Pure.
 */
export interface DigestStatusRow {
  cadence: "weekly" | "monthly";
  periodKey: string;
  label: string; // "Weekly 19–25 Oct 2026" / "Monthly September 2026"
  state: "waiting" | "ready" | "sent" | "skipped";
  statusText: string;
  nextSend: string | null; // null once sent, or skipped
  sentText: string | null; // "41 of 43 on Tue 20 Oct"
  recipients: number; // personal + company with this cadence
  sendNow: { label: "Send now" | "Send anyway"; confirm: string } | null; // null = no button (a monthly that isn't ready)
  missing: string[];
}

export interface DigestStatusInput {
  today: string;
  mode: NotifyMode;
  previewEmail: string | null;
  periods: {
    cadence: "weekly" | "monthly";
    period: DigestPeriod;
    readiness: { ready: boolean; missing: string[] };
    recipients: { personal: number; company: number };
    sends: { status: string; updatedAt: string }[];
    /** The period before the latest one: shown only while it has sends to show. */
    previous: boolean;
  }[];
}

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Tue 20 Oct" */
const dayLabel = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${SHORT[d.getUTCMonth()]}`;
};
const SEND_AT = "Next hourly run, from 10:30 in each person's own time zone";

/**
 * The day the cron would next send this cadence: today on a working day, else the next working
 * day; a monthly never before the 3rd. (The cron sends on any hourly run from 10:30 local, so a
 * digest that turns ready at 11:00 goes out at 11:30 — "today" is right even after 10:30.)
 */
export function nextAutomaticSendDay(today: string, cadence: "weekly" | "monthly"): string {
  let d = today;
  if (cadence === "monthly" && Number(d.slice(8, 10)) < 3) d = `${d.slice(0, 7)}-03`;
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
}

export function digestStatusRows(i: DigestStatusInput): DigestStatusRow[] {
  const preview = i.mode === "preview";
  return i.periods.flatMap((p) => {
    const sent = p.sends.filter((s) => s.status === "sent");
    if (p.previous && !sent.length) return [];
    const recipients = p.recipients.personal + p.recipients.company;
    const label = `${p.cadence === "weekly" ? "Weekly" : "Monthly"} ${p.period.label}`;
    const sendDay = nextAutomaticSendDay(i.today, p.cadence);
    const when =
      sendDay === i.today ? `today (${dayLabel(sendDay)})`
      : p.cadence === "monthly" && Number(i.today.slice(8, 10)) < 3 ? `${dayLabel(sendDay)} (from the 3rd)`
      : `${dayLabel(sendDay)} (the next working day)`;
    const previewNote = preview ? " (preview: to the preview inbox)" : "";
    const skipped = p.cadence === "weekly" && !sent.length && i.today > addDays(p.period.toExclusive, 4); // the Friday after the week has passed
    // A monthly is never sent before the 3rd (the automatic sources aren't final until then) — not by Send now either.
    const beforeThird = p.cadence === "monthly" && Number(i.today.slice(8, 10)) < 3;
    const ready = p.readiness.ready && !beforeThird;

    const state: DigestStatusRow["state"] = sent.length ? "sent" : skipped ? "skipped" : ready ? "ready" : "waiting";
    const waitingFor = [...(p.readiness.missing.length ? [`Waiting for ${p.readiness.missing.join(" · ")}`] : []), ...(beforeThird ? ["Due from the 3rd"] : [])];
    const statusText =
      state === "sent" ? "Sent"
      : state === "skipped" ? "Not ready by Friday, so it won't go out by itself. You can still send it now."
      : state === "ready" ? "Ready"
      : waitingFor.join(" · ");
    const nextSend =
      state === "sent" || state === "skipped" ? null
      : state === "ready" || (beforeThird && p.readiness.ready) ? `${SEND_AT}, ${when}${previewNote}`
      : `Once it's in: the next hourly run, from 10:30 in each person's own time zone${previewNote}`;
    const latest = sent.map((s) => s.updatedAt).sort().at(-1);
    const sentText = latest ? `${sent.length} of ${recipients} on ${dayLabel(latest.slice(0, 10))}` : null;

    const what = p.cadence === "weekly" ? `the weekly summary for ${p.period.label}` : `the ${p.period.label} recap`;
    const to = preview
      ? `to the preview inbox (${i.previewEmail ?? "SLACK_PREVIEW_EMAIL is not set"}) as ${recipients} preview messages`
      : `to ${p.recipients.personal} people${p.recipients.company ? ` (and the company report to ${p.recipients.company})` : ""}`;
    const sendNow: DigestStatusRow["sendNow"] =
      ready ? { label: "Send now", confirm: `Send ${what} now ${to}?` }
      : p.cadence === "weekly" ? { label: "Send anyway", confirm: `Still missing: ${p.readiness.missing.join(", ")}. Figures for those will be incomplete. Send anyway ${to}?` }
      : null;

    return [{ cadence: p.cadence, periodKey: p.period.key, label, state, statusText, nextSend, sentText, recipients, sendNow, missing: p.readiness.missing }];
  });
}
