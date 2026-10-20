import { formatUsd } from "@/lib/utils";
import type { CoverageCell, CoverageImportRow, CoverageMonthRow } from "@/lib/queries/import-coverage";

/**
 * Data → Imports: what this month's manual imports still need, and how each coverage cell reads.
 * Pure (dates are YYYY-MM-DD / YYYY-MM strings, no locale or time-zone formatting) so the server
 * render and tests agree.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const monthName = (month: string): string => MONTHS[Number(month.slice(5, 7)) - 1];
/** "2026-10-12" → "12 Oct". */
export const shortDay = (day: string): string => `${Number(day.slice(8, 10))} ${monthName(day.slice(0, 7)).slice(0, 3)}`;
/** Last day of a YYYY-MM month. */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}
/** The Sunday before `today` (YYYY-MM-DD); on a Monday, yesterday. */
export function lastSunday(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  return new Date(Date.parse(`${today}T00:00:00Z`) - (dow === 0 ? 7 : dow) * 86_400_000).toISOString().slice(0, 10);
}
function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export type TaskKey = "chatgptCredits" | "claudeSpend" | "chatgptSeats" | "claudeSeats";
export type ImportVendor = "chatgpt_business" | "claude_team";

export interface ChecklistItem {
  key: TaskKey;
  vendor: ImportVendor;
  label: string;
  done: boolean;
  status: string;
  detail: string | null;
  action: string;
  /** The section on the page that does it. */
  anchor: string;
}

export interface ImportChecklist {
  month: string;
  monthName: string;
  items: ChecklistItem[];
  /** Last month's tasks still not done (empty = complete). */
  previous: { month: string; monthName: string; outstanding: ChecklistItem[] };
}

/** A seat_month_entries row, as far as the checklist cares. */
export interface SeatEntryMark { vendor: string; month: string; seats?: number }

interface ChecklistInput {
  coverage: CoverageMonthRow[];
  imports: CoverageImportRow[];
  seatEntries: SeatEntryMark[];
  today: string; // YYYY-MM-DD
}

const ok = (r: CoverageImportRow) => r.status === "success";
const latest = (days: string[]): string | null => (days.length ? days.reduce((a, b) => (b > a ? b : a)) : null);

/**
 * Claude spend's state. This month it's due weekly: a paste dated on or after the Sunday just gone
 * (the weekly summary waits for it — notify/readiness.ts); before the month's first Sunday nothing is
 * due yet. An earlier month needs one paste.
 */
function claudeSpendState(month: string, current: boolean, asOf: string | null, today: string): { done: boolean; status: string } {
  if (!current) return { done: !!asOf, status: asOf ? `As of ${shortDay(asOf)}` : "Not pasted" };
  const due = lastSunday(today);
  if (due < `${month}-01`) return { done: true, status: asOf ? `Pasted as of ${shortDay(asOf)}` : "First paste due Monday" };
  if (asOf && asOf >= due) return { done: true, status: `Pasted as of ${shortDay(asOf)}` };
  return { done: false, status: asOf ? `Pasted as of ${shortDay(asOf)} · due as of ${shortDay(due)}` : `Due: paste as of ${shortDay(due)}` };
}

/**
 * The four monthly tasks for a month. Credits: the CSV is date-ranged, so a month is covered when
 * the furthest import reaches into it (the current month) or past its last day (an earlier one).
 * Claude spend: this month it's due weekly — a paste dated on or after the Sunday just gone (as the
 * weekly summary needs it); an earlier month needs one paste (its final table may not be retrievable). Seats: that month's invoice counts on file; a tier
 * (roster) upload is a different job and doesn't count.
 */
function tasksFor(month: string, current: boolean, input: ChecklistInput): ChecklistItem[] {
  const name = monthName(month);
  const row = input.coverage.find((r) => r.month === month);
  const usd = (c: CoverageCell | null | undefined) => formatUsd(c?.totalUsd ?? 0);

  const creditsThrough = latest(input.imports.filter((r) => ok(r) && r.source === "chatgpt_business" && r.kind === "csv").map((r) => r.dataAsOf));
  const creditsDone = !!creditsThrough && (current ? creditsThrough >= `${month}-01` : creditsThrough >= monthEnd(month));
  const credits: ChecklistItem = {
    key: "chatgptCredits", vendor: "chatgpt_business", label: "ChatGPT credits", done: creditsDone,
    status: creditsDone
      ? `Imported through ${shortDay(creditsThrough!)}`
      : current ? `Nothing for ${name} yet`
      : creditsThrough && creditsThrough >= `${month}-01` ? `Imported through ${shortDay(creditsThrough)} only` : "Not imported",
    detail: `${name} so far ${usd(row?.chatgptCredits)}`,
    action: creditsDone ? "Import a newer file" : "Import the credits file",
    anchor: "chatgpt-credits",
  };

  const spendAsOf = latest(input.imports.filter((r) => ok(r) && r.source === "claude_team" && r.kind === "clipboard" && r.dataAsOf.startsWith(month)).map((r) => r.dataAsOf));
  const { done: spendDone, status: spendStatus } = claudeSpendState(month, current, spendAsOf, input.today);
  const spend: ChecklistItem = {
    key: "claudeSpend", vendor: "claude_team", label: "Claude spend", done: spendDone,
    status: spendStatus,
    detail: `${name} so far ${usd(row?.claudeSpend)}`,
    action: spendDone ? "Paste a newer table" : "Paste the spend table",
    anchor: "claude-spend",
  };

  const seats = (vendor: ImportVendor, key: TaskKey, label: string, cell: CoverageCell | null | undefined, anchor: string): ChecklistItem => {
    const entries = input.seatEntries.filter((e) => e.vendor === vendor && e.month === month);
    const done = entries.length > 0;
    return {
      key, vendor, label, done,
      status: done ? `Entered: ${entries.reduce((s, e) => s + (e.seats ?? 0), 0)} seats` : "No invoice counts yet",
      detail: done ? `${usd(cell)} this month` : `Estimated ${usd(cell)} from synced members`,
      action: done ? `Change ${name} seats` : `Enter ${name} seats`,
      anchor,
    };
  };

  return [
    credits,
    spend,
    seats("chatgpt_business", "chatgptSeats", "ChatGPT seats", row?.chatgptSeats, "chatgpt-seats"),
    seats("claude_team", "claudeSeats", "Claude seats", row?.claudeSeats, "claude-seats"),
  ];
}

export function importChecklist(input: ChecklistInput): ImportChecklist {
  const month = input.today.slice(0, 7);
  const prev = previousMonth(month);
  return {
    month,
    monthName: monthName(month),
    items: tasksFor(month, true, input),
    previous: { month: prev, monthName: monthName(prev), outstanding: tasksFor(prev, false, input).filter((i) => !i.done) },
  };
}

/** One coverage cell as shown: a figure (with a note), a gap after tracking began, or a month before it. */
export type CoverageViewCell = { kind: "value"; usd: number; note: string | null; warn: boolean } | { kind: "gap" } | { kind: "before" };

export interface CoverageViewRow {
  month: string;
  chatgptCredits: CoverageViewCell;
  chatgptSeats: CoverageViewCell;
  claudeSpend: CoverageViewCell;
  claudeSeats: CoverageViewCell;
}

const COLUMNS = ["chatgptCredits", "chatgptSeats", "claudeSpend", "claudeSeats"] as const;
const SEAT_VENDOR: Partial<Record<(typeof COLUMNS)[number], ImportVendor>> = { chatgptSeats: "chatgpt_business", claudeSeats: "claude_team" };

/**
 * Coverage rows (newest first) → what each cell says. A missing figure before a column's first
 * month with data is "before" (not tracked yet), after it a "gap". Seat figures always exist (synced
 * members × price), so they say whether that month's invoice counts were entered; the current month
 * without them is a warning.
 */
export function coverageView(rows: CoverageMonthRow[], seatEntries: SeatEntryMark[], nowMonth: string): CoverageViewRow[] {
  const entered = new Set(seatEntries.map((e) => `${e.vendor}:${e.month}`));
  const firstMonth = Object.fromEntries(
    COLUMNS.map((c) => [c, rows.filter((r) => r[c] !== null).map((r) => r.month).sort()[0] ?? null]),
  ) as Record<(typeof COLUMNS)[number], string | null>;

  const view = (r: CoverageMonthRow, c: (typeof COLUMNS)[number]): CoverageViewCell => {
    const cell = r[c];
    if (!cell) return firstMonth[c] !== null && r.month > firstMonth[c]! ? { kind: "gap" } : { kind: "before" };
    const seatVendor = SEAT_VENDOR[c];
    if (seatVendor) {
      if (entered.has(`${seatVendor}:${r.month}`)) return { kind: "value", usd: cell.totalUsd, note: "invoice entered", warn: false };
      const now = r.month === nowMonth;
      return { kind: "value", usd: cell.totalUsd, note: now ? "estimate · no counts yet" : "estimate", warn: now };
    }
    const verb = c === "claudeSpend" ? "pasted" : "imported";
    return { kind: "value", usd: cell.totalUsd, note: cell.lastImport ? `${verb} ${shortDay(cell.lastImport)}` : null, warn: false };
  };

  return rows.map((r) => ({
    month: r.month,
    chatgptCredits: view(r, "chatgptCredits"),
    chatgptSeats: view(r, "chatgptSeats"),
    claudeSpend: view(r, "claudeSpend"),
    claudeSeats: view(r, "claudeSeats"),
  }));
}
