import type { PersonCursorUsageScope, PersonMonthUsage, UsageWeek } from "./types";

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);

function monthBounds(month: string): { first: number; next: number } {
  const [y, m] = month.split("-").map(Number);
  return { first: Date.UTC(y, m - 1, 1), next: Date.UTC(y, m, 1) };
}

/** Monday to Friday days in the month (no holiday calendar). */
export function workingDaysIn(month: string): number {
  const { first, next } = monthBounds(month);
  let n = 0;
  for (let t = first; t < next; t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/** The Monday of every week (Mon to Sun) that touches the month; the first may fall in the previous month. */
export function weeksOf(month: string): string[] {
  const { first, next } = monthBounds(month);
  const back = (new Date(first).getUTCDay() + 6) % 7;
  const mondays: string[] = [];
  for (let t = first - back * DAY_MS; t < next; t += 7 * DAY_MS) mondays.push(iso(t));
  return mondays;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** One month of a person's Cursor usage, or null when there are no rows in it. */
export function personMonthUsage(scope: PersonCursorUsageScope, month: string): PersonMonthUsage | null {
  const rows = scope.rows.filter((r) => r.day.startsWith(month));
  if (rows.length === 0) return null;
  const facts = scope.facts.filter((f) => f.day.startsWith(month));
  const seats = facts.filter((f) => f.costType === "seat");
  const overage = facts.filter((f) => f.costType === "overage");

  const modelCounts = new Map<string, number>();
  for (const r of rows) if (r.mostUsedModel) modelCounts.set(r.mostUsedModel, (modelCounts.get(r.mostUsedModel) ?? 0) + 1);
  let mostUsedModel: string | null = null;
  let best = 0;
  for (const [m, c] of modelCounts) if (c > best) { best = c; mostUsedModel = m; }

  const linesSuggested = sum(rows.map((r) => r.linesAdded + r.linesDeleted));
  const linesKept = sum(rows.map((r) => r.acceptedLinesAdded + r.acceptedLinesDeleted));
  const onDemandDays = [...overage.map((f) => f.day), ...rows.filter((r) => r.onDemandReqs > 0).map((r) => r.day)].sort();

  const rowByDay = new Map(rows.map((r) => [r.day, r]));
  const overageByDay = new Map<string, number>();
  for (const f of overage) overageByDay.set(f.day, (overageByDay.get(f.day) ?? 0) + f.costUsd);

  const weeks: UsageWeek[] = weeksOf(month).map((monday) => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const day = iso(utc(monday) + i * DAY_MS);
      const r = rowByDay.get(day);
      return {
        day,
        inMonth: day.startsWith(month),
        active: r?.isActive ?? false,
        agentRequests: r?.agentRequests ?? 0,
        onDemandUsd: overageByDay.get(day) ?? 0,
      };
    });
    const inMonth = days.filter((d) => d.inMonth);
    return { monday, days, requests: sum(inMonth.map((d) => d.agentRequests)), onDemandUsd: sum(inMonth.map((d) => d.onDemandUsd)) };
  });

  return {
    month,
    tiles: {
      activeDays: rows.filter((r) => r.isActive).length,
      workingDays: workingDaysIn(month),
      mostUsedModel,
      agentRequests: sum(rows.map((r) => r.agentRequests)),
      includedReqs: sum(rows.map((r) => r.includedReqs)),
      onDemandReqs: sum(rows.map((r) => r.onDemandReqs)),
      linesKept,
      linesSuggested,
      keptShare: linesSuggested ? linesKept / linesSuggested : null,
      seatUsd: sum(seats.map((f) => f.costUsd)),
      onDemandUsd: sum(overage.map((f) => f.costUsd)),
      onDemandFrom: onDemandDays[0] ?? null,
    },
    weeks,
  };
}
