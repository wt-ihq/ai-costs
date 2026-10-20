import type { ResolvedFact } from "./persist";

/**
 * Claude Team has no API: an admin pastes its month-to-date table (every Monday, and on a month's last
 * working day). Each paste is kept (claude_spend_snapshots) and a month's facts are rebuilt from them:
 * a person's increase since their previous paste is spread evenly over the days after it up to and
 * including the new paste's date (the month's first paste from the 1st). Exact per week once pastes
 * line up with weeks; an estimate per day — so daily summaries leave Claude Team out (digest.ts).
 * Each person's month totals their latest paste to the cent. Pure.
 */
export interface ClaudeSnapshotRow {
  asOf: string; // YYYY-MM-DD
  email: string;
  employeeId: string | null;
  mtdUsd: number;
}

const DAY_MS = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

export function spreadClaudeSnapshots(rows: ClaudeSnapshotRow[], month: string): ResolvedFact[] {
  const byEmail = new Map<string, ClaudeSnapshotRow[]>();
  for (const r of rows) if (r.asOf.startsWith(month)) byEmail.set(r.email, [...(byEmail.get(r.email) ?? []), r]);
  const out: ResolvedFact[] = [];
  for (const [email, own] of [...byEmail].sort(([a], [b]) => a.localeCompare(b))) {
    own.sort((a, b) => a.asOf.localeCompare(b.asOf));
    const employeeId = own.at(-1)!.employeeId;
    let prevDay = addDays(`${month}-01`, -1);
    let prevCents = 0;
    for (const s of own) {
      const cents = Math.round(s.mtdUsd * 100);
      const days = daysBetween(prevDay, s.asOf);
      const per = Math.trunc((cents - prevCents) / days);
      const rest = cents - prevCents - per * days;
      for (let i = 1; i <= days; i++) {
        const c = per + (i === days ? rest : 0);
        if (c !== 0) out.push({ source: "claude_team", day: addDays(prevDay, i), costType: "overage", entityKey: email, costUsd: c / 100, employeeId });
      }
      prevDay = s.asOf;
      prevCents = cents;
    }
  }
  return out;
}

/**
 * Who each pasted email is, at rebuild time: an admin's assignment (identities, vendor claude_team)
 * wins, then today's staff list by email, then the match made when it was pasted — so the nightly
 * rebuild keeps manual assignments and late roster fixes instead of reverting them to Unmatched.
 */
export function resolveSnapshotEmployees(
  rows: ClaudeSnapshotRow[],
  known: { identities: ReadonlyMap<string, string>; employees: { id: string; email: string }[] },
): ClaudeSnapshotRow[] {
  const byEmail = new Map(known.employees.map((e) => [e.email.toLowerCase(), e.id]));
  return rows.map((r) => {
    const email = r.email.toLowerCase();
    return { ...r, employeeId: known.identities.get(email) ?? byEmail.get(email) ?? r.employeeId };
  });
}

/**
 * The paste form's default date: Sunday on a Monday (the table includes Monday morning), else today —
 * but never last month: on Monday the 1st Claude's table has already reset, and a paste dated the
 * 31st would overwrite last month's total with a day of the new one.
 */
export function defaultPasteDate(today: string): string {
  const yesterday = addDays(today, -1);
  return new Date(`${today}T00:00:00Z`).getUTCDay() === 1 && yesterday.slice(0, 7) === today.slice(0, 7) ? yesterday : today;
}
