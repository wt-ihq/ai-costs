import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import { SYNCED_SOURCES, type SyncRunRow } from "./freshness";

/**
 * When a week's data is complete (spec 2026-10-20-weekly-readiness-design.md §2): every automatic
 * source in use synced successfully since the week ended, ChatGPT credits are imported through its
 * Sunday and Claude Team is pasted as of its Sunday (each import only if used in the last two
 * months). One definition for the run (hold), the reminder (list) and Data → Notifications (show).
 */

/** Sync runs read for readiness: long enough that a source failing for days still counts as in use. */
export const READINESS_SYNC_DAYS = 14;

export function readinessSyncSince(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - READINESS_SYNC_DAYS)).toISOString();
}

/** A successful `imports` row (data_as_of = the last day it covers). */
export interface ManualImportRow {
  source: string;
  kind: string;
  dataAsOf: string;
}

export type Outstanding =
  | { kind: "sync"; source: Vendor; lastSuccessDay: string | null }
  | { kind: "chatgptCredits"; through: string }
  | { kind: "claudeSpend"; asOf: string };

export interface Readiness {
  ready: boolean;
  outstanding: Outstanding[];
}

const DAY_MS = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string) => `${Number(d.slice(8, 10))} ${SHORT[Number(d.slice(5, 7)) - 1]}`;

/**
 * Sources in use — a successful run in the loaded window (or, when none succeeded at all, every
 * synced source) — without a successful run started on or after `sinceDay` (UTC).
 */
export function syncsOutstanding(runs: SyncRunRow[], sinceDay: string): Outstanding[] {
  const lastSuccess = new Map<string, string>();
  for (const r of runs) {
    if (r.status !== "success") continue;
    const day = r.startedAt.slice(0, 10);
    if ((lastSuccess.get(r.source) ?? "") < day) lastSuccess.set(r.source, day);
  }
  const inUse = SYNCED_SOURCES.filter((s) => lastSuccess.has(s));
  return (inUse.length ? inUse : SYNCED_SOURCES)
    .filter((s) => (lastSuccess.get(s) ?? "") < sinceDay)
    .map((source) => ({ kind: "sync" as const, source, lastSuccessDay: lastSuccess.get(source) ?? null }));
}

export function importsInUseSince(day: string): string {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 3, 1)).toISOString().slice(0, 10);
}

const MANUAL = [
  { kind: "chatgptCredits", source: "chatgpt_business", importKind: "csv" },
  { kind: "claudeSpend", source: "claude_team", importKind: "clipboard" },
] as const;

export function weekReadiness({ week, syncRuns, imports }: { week: { from: string; toExclusive: string }; syncRuns: SyncRunRow[]; imports: ManualImportRow[] }): Readiness {
  const lastDay = addDays(week.toExclusive, -1);
  const since = importsInUseSince(lastDay);
  const outstanding = syncsOutstanding(syncRuns, week.toExclusive);
  for (const m of MANUAL) {
    const dates = imports.filter((r) => r.source === m.source && r.kind === m.importKind && r.dataAsOf >= since).map((r) => r.dataAsOf);
    if (!dates.length) continue; // not in use
    const latest = dates.reduce((a, b) => (b > a ? b : a));
    if (latest >= lastDay) continue;
    outstanding.push(m.kind === "chatgptCredits" ? { kind: "chatgptCredits", through: latest } : { kind: "claudeSpend", asOf: latest });
  }
  return { ready: outstanding.length === 0, outstanding };
}

/** A short name for the status line: "Claude Team (pasted as of 11 Oct)". */
export function outstandingShort(o: Outstanding): string {
  if (o.kind === "claudeSpend") return `Claude Team (pasted as of ${short(o.asOf)})`;
  if (o.kind === "chatgptCredits") return `ChatGPT credits (through ${short(o.through)})`;
  return `${VENDOR_LABEL[o.source]} sync`;
}
