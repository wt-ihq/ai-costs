import { currentPeriod, parsePeriod, stepPeriod, type Period } from "@/lib/explore/period";
import type { Cadence, NotifyMode } from "./types";

export interface ChartBucketRange {
  label: string;
  from: string;
  toExclusive: string;
  current: boolean;
}

export interface DigestPeriod {
  cadence: Cadence;
  key: string; // period_key: "2026-09-29" | "2026-W39" | "2026-09"
  label: string; // dashboard label: "29 Sep 2026" | "21–27 Sep 2026" | "September 2026"
  from: string;
  toExclusive: string;
  prev: { from: string; toExclusive: string };
  /** What `prev` is, for "vs …" copy: "previous day" | "Friday" (a Monday's daily) | "previous week" | "previous month". */
  compareTo: string;
  buckets: ChartBucketRange[]; // oldest first; the last is this period
}

export const CHART_SPAN: Record<Cadence, number> = { daily: 14, weekly: 8, monthly: 6 };
export const CADENCE_UNIT: Record<Cadence, "day" | "week" | "month"> = { daily: "day", weekly: "week", monthly: "month" };
/**
 * Monthly recaps go out once ready, on any working day from the 3rd (monthToDate in run-all.ts
 * re-syncs the previous month through the 3rd, so automatic sources aren't final before then) to
 * the month's end. Never forced: an incomplete month waits.
 */
export const MONTHLY_WINDOW = { firstDay: 3 } as const;

export const inMonthlyWindow = (day: string) => Number(day.slice(8, 10)) >= MONTHLY_WINDOW.firstDay;

/** Digests go out on working days at 10:30 in each recipient's own Slack time zone. */
export const SEND_AT_MINUTES = 10 * 60 + 30;
/** Where nearly everyone is; used when Slack has no (or an unusable) zone for someone. */
export const DEFAULT_TZ = "Europe/London";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export const isWorkingDay = (day: string) => weekday(day) !== 0 && weekday(day) !== 6;

/** The working day before `day` (Friday for a Monday or a weekend day). */
export function previousWorkingDay(day: string): string {
  let d = addDays(day, -1);
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

function localClock(now: Date, tz: string): { day: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * The recipient's local day if a digest may go out to them now — a working
 * day there and 10:30 or later — else null. An unknown or invalid zone counts as London.
 */
export function sendDay(now: Date, tz: string | null): string | null {
  const local = localSafe(now, tz);
  return isWorkingDay(local.day) && local.minutes >= SEND_AT_MINUTES ? local.day : null;
}

/** The recipient's local day and time; an unknown or invalid zone counts as London. */
function localSafe(now: Date, tz: string | null): { day: string; minutes: number } {
  try {
    return localClock(now, tz ?? DEFAULT_TZ);
  } catch {
    return localClock(now, DEFAULT_TZ); // RangeError: Slack handed us a zone this runtime doesn't know
  }
}

/** Update reminders: Monday 09:30 (an hour before summaries) and the month's last working day 15:00, local time. */
export const WEEKLY_REMINDER_AT = 9 * 60 + 30;
export const MONTH_END_REMINDER_AT = 15 * 60;
/**
 * The month-end Claude Team paste reminder, three times on the last working day (the table resets
 * at midnight; nothing fires on the 1st). Each slot is its own claim; the 15:00 one keeps the bare
 * month key it has always had, so earlier claims still match.
 */
export type MonthEndSlot = "morning" | "afternoon" | "lastCall";
export const MONTH_END_SLOTS: readonly { slot: MonthEndSlot; at: number; keySuffix: string }[] = [
  { slot: "morning", at: 9 * 60 + 30, keySuffix: ":0930" },
  { slot: "afternoon", at: MONTH_END_REMINDER_AT, keySuffix: "" },
  { slot: "lastCall", at: 17 * 60 + 30, keySuffix: ":1730" },
];

/** The month's last working day ("YYYY-MM" → "YYYY-MM-DD"). */
export function lastWorkingDay(month: string): string {
  const [y, m] = month.split("-").map(Number);
  let d = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

export interface DueReminder {
  kind: "weekly" | "monthEnd";
  cadence: "weekly" | "monthly"; // the send log's cadence column
  periodKey: string; // the week's ISO key / the month (+ the slot's suffix)
  day: string; // the recipient's local day
  /** Which month-end slot (kind "monthEnd" only). */
  slot?: MonthEndSlot;
}

/** The reminders due to someone now, in their own time zone (run-reminders.ts). `anyTime`: a ?date= replay. */
export function dueReminders(now: Date, tz: string | null, opts: { anyTime?: boolean } = {}): DueReminder[] {
  const local = localSafe(now, tz);
  if (!isWorkingDay(local.day)) return [];
  const at = (min: number) => opts.anyTime || local.minutes >= min;
  const out: DueReminder[] = [];
  if (weekday(local.day) === 1 && at(WEEKLY_REMINDER_AT)) {
    out.push({ kind: "weekly", cadence: "weekly", periodKey: latestCompleteKey("weekly", new Date(`${local.day}T12:00:00Z`)), day: local.day });
  }
  if (local.day === lastWorkingDay(local.day.slice(0, 7))) {
    // Only the latest slot that is due: a slot the cron missed is never sent late alongside the next one.
    const due = MONTH_END_SLOTS.filter((s) => at(s.at)).at(-1);
    if (due) out.push({ kind: "monthEnd", cadence: "monthly", periodKey: `${local.day.slice(0, 7)}${due.keySuffix}`, day: local.day, slot: due.slot });
  }
  return out;
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact axis label: month name on the first bar and wherever the month changes. */
function bucketLabel(p: Period, prev: Period | null): string {
  const d = new Date(`${p.from}T00:00:00Z`);
  if (p.granularity === "month") return SHORT[d.getUTCMonth()];
  const monthChanged = !prev || prev.from.slice(0, 7) !== p.from.slice(0, 7);
  return monthChanged ? `${d.getUTCDate()} ${SHORT[d.getUTCMonth()]}` : String(d.getUTCDate());
}

export function periodFor(cadence: Cadence, key: string, now: Date): DigestPeriod {
  const p = parsePeriod(key, now);
  // parsePeriod falls back to the current month on bad input — check the round-trip.
  if (p.granularity !== CADENCE_UNIT[cadence] || p.anchor !== key) {
    throw new Error(`periodFor: "${key}" is not a ${cadence} period`);
  }
  // A daily compares with the previous WORKING day: a Monday against Friday, not a near-empty Sunday.
  const prev = cadence === "daily" ? parsePeriod(previousWorkingDay(key), now) : stepPeriod(p, -1, now);
  const compareTo =
    cadence === "daily" && prev.from !== addDays(key, -1) ? WEEKDAYS[weekday(prev.from)] : `previous ${CADENCE_UNIT[cadence]}`;
  const span: Period[] = [p];
  for (let i = 1; i < CHART_SPAN[cadence]; i++) span.unshift(stepPeriod(span[0], -1, now));
  return {
    cadence,
    key,
    label: p.label,
    from: p.from,
    toExclusive: p.toExclusive,
    prev: { from: prev.from, toExclusive: prev.toExclusive },
    compareTo,
    buckets: span.map((q, i) => ({
      label: bucketLabel(q, i ? span[i - 1] : null),
      from: q.from,
      toExclusive: q.toExclusive,
      current: i === span.length - 1,
    })),
  };
}

/** Key of the most recent COMPLETE period (yesterday / last week / last month). */
export function latestCompleteKey(cadence: Cadence, now: Date): string {
  return stepPeriod(currentPeriod(CADENCE_UNIT[cadence], now), -1, now).anchor;
}

/** Preview ◀ ▶ navigation; null when the step would reach the current (incomplete) period. */
export function stepKey(cadence: Cadence, key: string, dir: -1 | 1, now: Date): string | null {
  const next = stepPeriod(periodForAnchor(cadence, key, now), dir, now);
  const latest = periodForAnchor(cadence, latestCompleteKey(cadence, now), now);
  return next.from > latest.from ? null : next.anchor;
}

function periodForAnchor(cadence: Cadence, key: string, now: Date): Period {
  const p = parsePeriod(key, now);
  if (p.granularity !== CADENCE_UNIT[cadence] || p.anchor !== key) throw new Error(`"${key}" is not a ${cadence} period`);
  return p;
}

/** The admin preview's default period: what would go out today (a Monday or weekend shows Friday's daily). */
export function defaultPreviewKey(cadence: Cadence, now: Date): string {
  return cadence === "daily" ? previousWorkingDay(now.toISOString().slice(0, 10)) : latestCompleteKey(cadence, now);
}

export interface DueDigest {
  period: DigestPeriod;
}

/**
 * What may go out on a recipient's local working `day`: the previous working day's daily (Monday
 * carries Friday; weekend spend is in the weekly); the latest complete week's weekly once that week
 * is ready (any working day — a week not ready by Friday is skipped, as Monday moves on); last
 * month's recap once ready (readiness.ts and run-notify.ts decide `ready`).
 */
export function dueDigests(day: string, ready: { week: boolean; month: boolean }): DueDigest[] {
  if (!isWorkingDay(day)) return [];
  const now = new Date(`${day}T12:00:00Z`); // a moment inside that day, for the period helpers
  const out: DueDigest[] = [{ period: periodFor("daily", previousWorkingDay(day), now) }];
  if (ready.week) out.push({ period: periodFor("weekly", latestCompleteKey("weekly", now), now) });
  if (ready.month && inMonthlyWindow(day)) out.push({ period: periodFor("monthly", latestCompleteKey("monthly", now), now) });
  return out;
}

/**
 * `?date=YYYY-MM-DD` on the cron replays that day (as of 07:00 UTC, after the
 * sync) and sends straight away, skipping the 10:30 wait — preview mode ONLY:
 * in live mode a replay would DM real people about old periods.
 */
export function resolveRunDate(param: string | null, mode: NotifyMode, realNow: Date): { now: Date; replay: boolean } | { error: string } {
  if (!param) return { now: realNow, replay: false };
  if (mode !== "preview") return { error: "?date= replays are only allowed in preview mode" };
  const d = new Date(`${param}T07:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(param) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== param) {
    return { error: "date must be a real YYYY-MM-DD" };
  }
  return { now: d, replay: true };
}
