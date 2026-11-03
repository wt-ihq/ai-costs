export type RecTool = "cursor" | "claude_team" | "chatgpt_business";
export const REC_TOOLS: readonly RecTool[] = ["cursor", "claude_team", "chatgpt_business"];

export interface RecWeek {
  from: string;
  toExclusive: string;
}
export type RecTier = "standard" | "premium" | "free" | "unassigned" | "unknown";
export interface RecCandidate {
  employeeId: string;
  name: string;
  department: string | null;
  tier: RecTier;
  leaveDate: string | null;
}
export interface RecSpend {
  employeeId: string;
  day: string;
  costUsd: number;
}
export interface RecUsage {
  employeeId: string;
  day: string;
  agentRequests: number;
  isActive: boolean;
}
export interface RecToolInput {
  tool: RecTool;
  stepUpUsd: number;
  candidates: RecCandidate[];
  spend: RecSpend[];
  usage?: RecUsage[];
}
export type RecPattern = "steady" | "recent" | "one-off" | "on and off";
export interface RecWeekCell extends RecWeek {
  extraUsd: number;
  requests: number | null;
  activeDays: number | null;
}
export interface RecRow {
  employeeId: string;
  name: string;
  department: string | null;
  tierUnknown: boolean;
  extraUsd: number;
  savingUsd: number;
  weeks: RecWeekCell[];
  pattern: RecPattern;
  newThisWeek: boolean;
}
export interface RecToolResult {
  tool: RecTool;
  stepUpUsd: number;
  rows: RecRow[];
  premiumCount: number;
  totalSavingUsd: number;
}

const DAY_MS = 86_400_000;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** The most recent Sunday (UTC) on or before `now`. */
export function latestSunday(now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -dow);
}

/** `count` Monday-to-Monday weeks ending on `sunday`, oldest first. */
export function weeksEnding(sunday: string, count: number): RecWeek[] {
  const weeks: RecWeek[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const toExclusive = addDays(sunday, 1 - 7 * i);
    weeks.push({ from: addDays(toExclusive, -7), toExclusive });
  }
  return weeks;
}

export function patternWord(weeks: { extraUsd: number }[], stepUpUsd: number): RecPattern {
  const threshold = stepUpUsd / 4;
  const counting = weeks.map((w, i) => (w.extraUsd >= threshold ? i : -1)).filter((i) => i >= 0);
  if (counting.length === 0) return "on and off";
  if (counting.length >= 3) return "steady";
  const last = weeks.length - 1;
  if (counting.every((i) => i >= last - 1)) return "recent";
  if (counting.length === 1) return "one-off";
  return "on and off";
}

function sumByWeek<T extends { employeeId: string; day: string }>(
  rows: T[],
  weeks: RecWeek[],
  value: (r: T) => number,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const w = weeks.findIndex((x) => r.day >= x.from && r.day < x.toExclusive);
    if (w < 0) continue;
    let arr = out.get(r.employeeId);
    if (!arr) out.set(r.employeeId, (arr = weeks.map(() => 0)));
    arr[w] += value(r);
  }
  return out;
}

function flaggedIds(
  eligible: Set<string>,
  spend: RecSpend[],
  weeks: RecWeek[],
  stepUpUsd: number,
): Set<string> {
  const flagged = new Set<string>();
  for (const [id, arr] of sumByWeek(spend, weeks, (r) => r.costUsd)) {
    if (eligible.has(id) && cents(arr.reduce((a, b) => a + b, 0)) > stepUpUsd) flagged.add(id);
  }
  return flagged;
}

export function recommend(input: RecToolInput, sunday: string): RecToolResult {
  const { tool, stepUpUsd, spend, usage } = input;

  const known = new Set(input.candidates.map((c) => c.employeeId));
  const candidates: RecCandidate[] = [...input.candidates];
  for (const s of spend) {
    if (known.has(s.employeeId)) continue;
    known.add(s.employeeId);
    candidates.push({ employeeId: s.employeeId, name: s.employeeId, department: null, tier: "unknown", leaveDate: null });
  }
  const active = candidates.filter((c) => c.leaveDate === null);
  const premiumCount = active.filter((c) => c.tier === "premium").length;
  const eligibleList = active.filter((c) => c.tier === "standard" || c.tier === "unknown");
  const eligible = new Set(eligibleList.map((c) => c.employeeId));

  const weeks = weeksEnding(sunday, 4);
  const spendByWeek = sumByWeek(spend, weeks, (r) => r.costUsd);
  const requestsByWeek = usage ? sumByWeek(usage, weeks, (r) => r.agentRequests) : null;
  const activeDaysByWeek = usage ? sumByWeek(usage, weeks, (r) => (r.isActive ? 1 : 0)) : null;
  const previous = flaggedIds(eligible, spend, weeksEnding(addDays(sunday, -7), 4), stepUpUsd);

  const rows: RecRow[] = [];
  for (const c of eligibleList) {
    const amounts = spendByWeek.get(c.employeeId) ?? weeks.map(() => 0);
    const total = cents(amounts.reduce((a, b) => a + b, 0));
    if (total <= stepUpUsd) continue;
    const cells: RecWeekCell[] = weeks.map((w, i) => ({
      ...w,
      extraUsd: cents(amounts[i]),
      requests: requestsByWeek ? (requestsByWeek.get(c.employeeId)?.[i] ?? 0) : null,
      activeDays: activeDaysByWeek ? (activeDaysByWeek.get(c.employeeId)?.[i] ?? 0) : null,
    }));
    rows.push({
      employeeId: c.employeeId,
      name: c.name,
      department: c.department,
      tierUnknown: c.tier === "unknown",
      extraUsd: total,
      savingUsd: cents(total - stepUpUsd),
      weeks: cells,
      pattern: patternWord(cells, stepUpUsd),
      newThisWeek: !previous.has(c.employeeId),
    });
  }
  rows.sort((a, b) => b.savingUsd - a.savingUsd || a.name.localeCompare(b.name));

  return {
    tool,
    stepUpUsd,
    rows,
    premiumCount,
    totalSavingUsd: cents(rows.reduce((a, r) => a + r.savingUsd, 0)),
  };
}
