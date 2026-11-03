import type { CursorFactLite, CursorUsageDay, PersonCursorUsageScope, PersonMonthUsage, TeamCursorUsageScope, TeamMonthUsage, TeamPersonMonth, UsageWeek } from "./types";

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

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Sum daily usage rows and Cursor seat/on-demand facts per (person, month) for the cached team scope.
 * Usage rows first, in the order given (the reader's day, id), so each entry sits at its first usage
 * row; facts of people with no usage that month come after. Facts without a person are ignored.
 */
export function aggregateTeamMonths(rows: CursorUsageDay[], facts: CursorFactLite[]): TeamPersonMonth[] {
  const out = new Map<string, TeamPersonMonth>();
  const entry = (month: string, employeeId: string | null) => {
    const key = `${month}|${employeeId ?? ""}`;
    let e = out.get(key);
    if (!e) {
      e = { month, employeeId, usageDays: 0, activeDays: 0, agentRequests: 0, includedReqs: 0, onDemandReqs: 0, linesKept: 0, linesSuggested: 0, hasSeat: false, seatUsd: 0, onDemandUsd: 0 };
      out.set(key, e);
    }
    return e;
  };
  for (const r of rows) {
    const e = entry(r.day.slice(0, 7), r.employeeId);
    e.usageDays++;
    if (r.isActive) e.activeDays++;
    e.agentRequests += r.agentRequests;
    e.includedReqs += r.includedReqs;
    e.onDemandReqs += r.onDemandReqs;
    e.linesKept += r.acceptedLinesAdded + r.acceptedLinesDeleted;
    e.linesSuggested += r.linesAdded + r.linesDeleted;
  }
  for (const f of facts) {
    if (!f.employeeId) continue;
    const e = entry(f.day.slice(0, 7), f.employeeId);
    if (f.costType === "seat") {
      e.hasSeat = true;
      e.seatUsd += f.costUsd;
    } else e.onDemandUsd += f.costUsd;
  }
  return [...out.values()];
}

/** One month of team-wide Cursor usage (admin view), or null when there are no usage rows in it. */
export function teamMonthUsage(scope: TeamCursorUsageScope, month: string): TeamMonthUsage | null {
  const entries = scope.months.filter((m) => m.month === month);
  const withUsage = entries.filter((m) => m.usageDays > 0);
  if (withUsage.length === 0) return null;
  const byId = new Map(scope.people.map((p) => [p.employeeId, p]));
  const of = new Map(entries.flatMap((m) => (m.employeeId ? [[m.employeeId, m] as const] : [])));

  const seatHolders = entries.filter((m) => m.employeeId && m.hasSeat && byId.has(m.employeeId)).map((m) => m.employeeId!);
  const days = (id: string) => of.get(id)?.activeDays ?? 0;
  const unused = seatHolders.filter((id) => days(id) === 0);
  const little = seatHolders
    .filter((id) => days(id) <= 1)
    .sort((a, b) => days(a) - days(b) || byId.get(a)!.name.localeCompare(byId.get(b)!.name));
  const people = withUsage.filter((m) => m.employeeId); // people with usage rows this month
  const linesSuggested = sum(withUsage.map((m) => m.linesSuggested));
  const linesKept = sum(withUsage.map((m) => m.linesKept));
  // Median over seat holders (so unused seats count as 0); fall back to people with rows when seats are unknown.
  const medianBase = seatHolders.length ? seatHolders : people.map((m) => m.employeeId!);

  return {
    month,
    tiles: {
      peopleActive: people.filter((m) => m.activeDays > 0).length,
      seats: seatHolders.length,
      unusedSeats: unused.length,
      agentRequests: sum(withUsage.map((m) => m.agentRequests)),
      includedReqs: sum(withUsage.map((m) => m.includedReqs)),
      onDemandReqs: sum(withUsage.map((m) => m.onDemandReqs)),
      linesKept,
      keptShare: linesSuggested ? linesKept / linesSuggested : null,
      medianActiveDays: median(medianBase.map(days)),
      workingDays: workingDaysIn(month),
    },
    mostActive: people
      .filter((m) => byId.has(m.employeeId!))
      .sort((a, b) => b.agentRequests - a.agentRequests)
      .slice(0, 10)
      .map((m) => ({ employeeId: m.employeeId!, name: byId.get(m.employeeId!)!.name, href: byId.get(m.employeeId!)!.href, agentRequests: m.agentRequests, onDemandUsd: m.onDemandUsd })),
    littleUse: little.slice(0, 10).map((id) => ({ employeeId: id, name: byId.get(id)!.name, href: byId.get(id)!.href, activeDays: days(id), seatUsd: of.get(id)?.seatUsd ?? 0 })),
    littleUseMore: Math.max(0, little.length - 10),
    unusedSeatsUsd: sum(unused.map((id) => of.get(id)?.seatUsd ?? 0)),
  };
}
