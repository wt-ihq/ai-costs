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
  buckets: ChartBucketRange[]; // oldest first; the last is this period
}

export const CHART_SPAN: Record<Cadence, number> = { daily: 14, weekly: 8, monthly: 6 };
export const CADENCE_UNIT: Record<Cadence, "day" | "week" | "month"> = { daily: "day", weekly: "week", monthly: "month" };
/**
 * Monthly recaps go out on the first morning from the 3rd when the month is
 * ready, and on the 5th regardless. The 3rd because monthToDate (run-all.ts)
 * re-syncs the previous month through the 3rd — automatic sources aren't final before then.
 */
export const MONTHLY_WINDOW = { firstDay: 3, lastDay: 5 } as const;

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
  const prev = stepPeriod(p, -1, now);
  const span: Period[] = [p];
  for (let i = 1; i < CHART_SPAN[cadence]; i++) span.unshift(stepPeriod(span[0], -1, now));
  return {
    cadence,
    key,
    label: p.label,
    from: p.from,
    toExclusive: p.toExclusive,
    prev: { from: prev.from, toExclusive: prev.toExclusive },
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

export interface DueDigest {
  period: DigestPeriod;
  /** Monthly sent on the window's last day although not ready (caveats explain what's missing). */
  force: boolean;
}

export function dueDigests(now: Date, monthlyReady: boolean): DueDigest[] {
  const out: DueDigest[] = [{ period: periodFor("daily", latestCompleteKey("daily", now), now), force: false }];
  if (now.getUTCDay() === 1) out.push({ period: periodFor("weekly", latestCompleteKey("weekly", now), now), force: false });
  const dom = now.getUTCDate();
  if (dom >= MONTHLY_WINDOW.firstDay && dom <= MONTHLY_WINDOW.lastDay && (monthlyReady || dom === MONTHLY_WINDOW.lastDay)) {
    out.push({ period: periodFor("monthly", latestCompleteKey("monthly", now), now), force: !monthlyReady });
  }
  return out;
}

/**
 * `?date=YYYY-MM-DD` on the cron replays that morning (07:00 UTC) — preview
 * mode ONLY: in live mode a replay would DM real people about old periods.
 */
export function resolveRunDate(param: string | null, mode: NotifyMode, realNow: Date): { now: Date } | { error: string } {
  if (!param) return { now: realNow };
  if (mode !== "preview") return { error: "?date= replays are only allowed in preview mode" };
  const d = new Date(`${param}T07:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(param) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== param) {
    return { error: "date must be a real YYYY-MM-DD" };
  }
  return { now: d };
}
