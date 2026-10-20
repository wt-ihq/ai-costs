# Weekly Readiness, Claude Team in the Weekly, Monday Reminders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slack summaries go out only when the period's data is complete; Claude Team spend (a manual Monday paste) counts in weekly summaries; admins on a list get a Monday reminder of what's left to do.

**Architecture:** Every Claude Team paste is kept (`claude_spend_snapshots`) and its month's facts are rebuilt as daily facts by spreading each increase over the days since the previous paste, so Claude Team becomes ordinary daily usage and Explore's month-lump machinery is retired. A pure `weekReadiness` decides when a week is complete (syncs + ChatGPT credits + Claude paste); `dueDigests` sends weeklies any working day once ready and never forces monthlies. A separate `runReminders` (run first by the notify cron) DMs reminder recipients on Monday 09:30 and the month's last working day 15:00, claimed in `notification_sends` with report `reminder`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (PostgREST), Vitest, Slack Web API (existing `SlackClient`).

**Spec:** `docs/superpowers/specs/2026-10-20-weekly-readiness-design.md`

## Global Constraints

- Every `"use server"` action starts with `await requireAdmin()` (`src/lib/auth-guard.ts`).
- Any read of a growing table paginates (`pageAll` in `src/lib/notify/store.ts`) with a unique ORDER BY tiebreaker (gotcha #1).
- All windows are exclusive-end `[startDate, endDate)`; facts are replaced with `persist.ts:replaceWindowFacts` (upsert first, then prune) — never delete-then-insert, and an empty snapshot is a no-op unless `pruneWhenEmpty` (gotcha #4).
- Writes to `spend_facts` bust the cache: `updateTag(FACTS_TAG)` in Server Actions; route handlers use `revalidateTag(FACTS_TAG, "max")`.
- Changing the shape of anything a `*Cached` reader returns bumps `CACHE_VERSION` (`src/lib/queries/cached.ts`) **in the same commit**.
- `notification_sends` is claim-before-send: never make a row retryable once a DM may have gone out (`PostOutcomeUnknownError` → leave pending).
- Migration `0024_weekly_readiness.sql` is applied by the user in the Supabase SQL editor **before** deploy. No agent-initiated production deletes.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Branch: `weekly-readiness`. Do not push or deploy.
- Before every commit: `npm run test` passes. Before the final commit also `npm run lint` and `CI=true npm run build`.
- Copy: plain language, no jargon; user-visible changes get a `CHANGELOG` entry (`src/lib/changelog.ts`, newest first).

## Review Focus

1. **Pastes made out of order** (an earlier date pasted after a later one, or the same date pasted twice) must give the same daily facts as pasting in order — Task 2 test "out-of-order pastes give the same facts".
2. **A week straddling two months** (26 Oct – 1 Nov): the Claude paste as of 1 Nov makes it ready; one as of 31 Oct doesn't — Task 5 test.
3. **A source that is configured but has never synced** must not block every week forever, yet **no source synced at all** must not count as ready — Task 5 tests "ignores a source with no success in the window" and "nothing synced at all is not ready".
4. **A reminder recipient east of UTC** (Sydney: Monday 09:30 local is Sunday in UTC) gets the reminder for the week that just ended in *their* calendar — Task 8 test.
5. **A month ending on a weekend** (October 2026 ends on a Saturday): the month-end reminder goes on Friday the 30th — Task 8 test.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0024_weekly_readiness.sql` (new) | snapshots table + seed, reminder recipients table, `report` check |
| `src/lib/ingest/claude-spread.ts` (new) | pure: pastes → daily facts; paste-date default |
| `src/lib/ingest/run-claude-spend.ts` (new) | DB: save a paste, rebuild months from snapshots |
| `src/lib/explore/shape.ts`, `project.ts`, `build.ts`, `src/lib/queries/explore.ts`, `cached.ts` | retire the month-lump (snapshot) path |
| `src/lib/notify/readiness.ts` (new) | pure: is a week complete, what's outstanding |
| `src/lib/notify/schedule.ts` | `dueDigests` (ready flags, no force), `dueReminders` |
| `src/lib/notify/run-notify.ts` | uses readiness; daily-only sync hold; `held` |
| `src/lib/notify/reminders.ts` (new) | pure: reminder messages |
| `src/lib/notify/run-reminders.ts` (new) | claim → DM reminders |
| `src/lib/notify/week-status.ts` (new) | pure: Data → Notifications status line |
| `src/lib/notify/store.ts`, `memory-store.ts`, `types.ts` | `manualImports`, `reminderRecipients`, `SendReport` |
| `src/components/claude-rebuild.tsx`, `src/components/notifications/reminder-recipients.tsx` (new) | admin UI |
| `src/lib/imports/checklist.ts` | weekly Claude paste wording |

---

### Task 1: Migration 0024 and the Okta-removal guard

**Files:**
- Create: `supabase/migrations/0024_weekly_readiness.sql`
- Modify: `src/lib/ingest/persist.ts` (`removeOktaEmployees`, the digest-list loop ~line 202)
- Test: `src/lib/ingest/persist.test.ts` (the fake's `lists` map ~line 222)

**Interfaces:**
- Produces: tables `claude_spend_snapshots (as_of, email, employee_id, mtd_gbp, usd_per_gbp, mtd_usd, created_by, created_at)` PK `(as_of, email)`; `notification_reminder_recipients (employee_id pk, created_by, created_at)`; `notification_sends.report` may be `'reminder'`.

- [ ] **Step 1: Write the migration**

```sql
-- Weekly readiness, Claude Team in the weekly summary, Monday reminders
-- (spec: docs/superpowers/specs/2026-10-20-weekly-readiness-design.md).
-- Apply BEFORE deploying: the paste saves snapshots, the cron reads reminder recipients and
-- writes notification_sends.report = 'reminder'. Inserts and schema only; nothing is deleted.

-- Every Claude Team month-to-date paste, kept so a week's spend is the change between pastes.
create table if not exists claude_spend_snapshots (
  as_of        date not null,          -- the paste's date; its month is the month it belongs to
  email        text not null,
  employee_id  uuid references employees(id) on delete set null,
  mtd_gbp      numeric(12,2),          -- null only for rows seeded from old facts
  usd_per_gbp  numeric(12,6),          -- null only for rows seeded from old facts
  mtd_usd      numeric(12,2) not null,
  created_by   text,
  created_at   timestamptz not null default now(),
  primary key (as_of, email)
);
alter table claude_spend_snapshots enable row level security;

-- Seed: each stored month-to-date fact (one per person per month, dated the 1st) becomes a snapshot
-- as of that month's latest successful paste, else the month's last day (today for this month).
insert into claude_spend_snapshots (as_of, email, employee_id, mtd_usd, created_by)
select
  coalesce(
    (select max(i.data_as_of) from imports i
      where i.source = 'claude_team' and i.kind = 'clipboard' and i.status = 'success'
        and date_trunc('month', i.data_as_of) = date_trunc('month', f.day)),
    least((date_trunc('month', f.day) + interval '1 month - 1 day')::date, current_date)
  ),
  f.entity_key, f.employee_id, f.cost_usd, 'migration 0024'
from spend_facts f
where f.source = 'claude_team' and f.cost_type = 'overage' and extract(day from f.day) = 1 and f.cost_usd > 0
on conflict (as_of, email) do nothing;

-- Who gets the Monday "weekly updates" reminder and the month-end Claude Team reminder.
create table if not exists notification_reminder_recipients (
  employee_id uuid primary key references employees(id) on delete cascade,
  created_by  text not null,
  created_at  timestamptz not null default now()
);
alter table notification_reminder_recipients enable row level security;

-- Reminders are claimed in the send log like digests (never twice).
alter table notification_sends drop constraint if exists notification_sends_report_check;
alter table notification_sends
  add constraint notification_sends_report_check check (report in ('personal', 'company', 'reminder'));
```

- [ ] **Step 2: Keep reminder recipients through Okta removals**

In `src/lib/ingest/persist.ts`, `removeOktaEmployees`: the list of cascade tables becomes

```ts
  for (const table of ["notification_subscriptions", "notification_company_recipients", "notification_reminder_recipients"]) {
```

and the doc comment's line "digest subscriptions and company-report places would CASCADE away silently" becomes "digest subscriptions, company-report places and update-reminder places would CASCADE away silently".

- [ ] **Step 3: Update the persist test fake and add a test**

In `src/lib/ingest/persist.test.ts` the fake's map (~line 222) becomes:

```ts
  const lists: Record<string, string[]> = {
    notification_subscriptions: opts.subscribed ?? [],
    notification_company_recipients: opts.companyRecipients ?? [],
    notification_reminder_recipients: opts.reminderRecipients ?? [],
  };
```

and its `opts` type becomes `{ referenced?: string[]; subscribed?: string[]; companyRecipients?: string[]; reminderRecipients?: string[] }`. Add to `describe("removeOktaEmployees")`:

```ts
  it("keeps anyone on the update-reminder list", async () => {
    const db = fakeOktaRemovalDb([{ id: "r", okta_id: "00ur" }, { id: "x", okta_id: "00ux" }], { reminderRecipients: ["r"] });
    expect(await removeOktaEmployees(db.client, ["00ur", "00ux"])).toEqual({ removed: 1, kept: ["00ur"] });
    expect(db.deleted).toEqual(["x"]);
  });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/ingest/persist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0024_weekly_readiness.sql src/lib/ingest/persist.ts src/lib/ingest/persist.test.ts
git commit -m "feat(db): 0024 Claude Team paste snapshots, update-reminder recipients, reminder sends

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Spread Claude Team pastes into daily facts (pure)

**Files:**
- Create: `src/lib/ingest/claude-spread.ts`
- Test: `src/lib/ingest/claude-spread.test.ts`

**Interfaces:**
- Consumes: `ResolvedFact` from `src/lib/ingest/persist.ts`.
- Produces:
  - `interface ClaudeSnapshotRow { asOf: string; email: string; employeeId: string | null; mtdUsd: number }`
  - `spreadClaudeSnapshots(rows: ClaudeSnapshotRow[], month: string): ResolvedFact[]` — `month` is `YYYY-MM`; returns `claude_team`/`overage` facts.
  - `defaultPasteDate(today: string): string` — yesterday on a Monday, else today.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { defaultPasteDate, spreadClaudeSnapshots, type ClaudeSnapshotRow } from "./claude-spread";

const snap = (asOf: string, email: string, mtdUsd: number, employeeId: string | null = `e-${email}`): ClaudeSnapshotRow => ({ asOf, email, employeeId, mtdUsd });
const byDay = (facts: ReturnType<typeof spreadClaudeSnapshots>, email: string) =>
  Object.fromEntries(facts.filter((f) => f.entityKey === email).map((f) => [f.day, f.costUsd]));
const total = (facts: ReturnType<typeof spreadClaudeSnapshots>, email: string) =>
  Math.round(facts.filter((f) => f.entityKey === email).reduce((s, f) => s + f.costUsd, 0) * 100) / 100;

describe("spreadClaudeSnapshots", () => {
  it("spreads a month's first paste from the 1st to its date", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-04", "p@x", 40)], "2026-10");
    expect(byDay(f, "p@x")).toEqual({ "2026-10-01": 10, "2026-10-02": 10, "2026-10-03": 10, "2026-10-04": 10 });
    expect(f[0]).toMatchObject({ source: "claude_team", costType: "overage", entityKey: "p@x", employeeId: "e-p@x" });
  });

  it("spreads each later paste's increase over the days since the previous paste", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-04", "p@x", 40), snap("2026-10-11", "p@x", 110)], "2026-10");
    expect(byDay(f, "p@x")["2026-10-05"]).toBe(10);
    expect(byDay(f, "p@x")["2026-10-11"]).toBe(10);
    expect(total(f, "p@x")).toBe(110);
  });

  it("keeps a person's last value when they're missing from a later paste", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-04", "p@x", 40), snap("2026-10-04", "q@x", 8), snap("2026-10-11", "p@x", 110)], "2026-10");
    expect(total(f, "q@x")).toBe(8);
    expect(Object.keys(byDay(f, "q@x"))).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  });

  it("spreads a decrease too, so the month still equals the latest paste", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-04", "p@x", 40), snap("2026-10-11", "p@x", 33)], "2026-10");
    expect(byDay(f, "p@x")["2026-10-05"]).toBe(-1);
    expect(total(f, "p@x")).toBe(33);
  });

  it("is exact to the cent: the remainder lands on the paste's own day", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-03", "p@x", 10)], "2026-10");
    expect(byDay(f, "p@x")).toEqual({ "2026-10-01": 3.33, "2026-10-02": 3.33, "2026-10-03": 3.34 });
  });

  it("only uses pastes dated in the month", () => {
    const f = spreadClaudeSnapshots([snap("2026-09-30", "p@x", 500), snap("2026-10-02", "p@x", 20)], "2026-10");
    expect(byDay(f, "p@x")).toEqual({ "2026-10-01": 10, "2026-10-02": 10 });
  });

  it("out-of-order pastes give the same facts", () => {
    const rows = [snap("2026-10-11", "p@x", 110), snap("2026-10-04", "p@x", 40)];
    expect(spreadClaudeSnapshots(rows, "2026-10")).toEqual(spreadClaudeSnapshots([...rows].reverse(), "2026-10"));
  });

  it("uses the latest paste's employee for every day", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-04", "p@x", 40, null), snap("2026-10-11", "p@x", 110, "e-1")], "2026-10");
    expect(new Set(f.map((x) => x.employeeId))).toEqual(new Set(["e-1"]));
  });
});

describe("defaultPasteDate", () => {
  it("is Sunday on a Monday (the table includes Monday morning), today otherwise", () => {
    expect(defaultPasteDate("2026-10-19")).toBe("2026-10-18");
    expect(defaultPasteDate("2026-10-20")).toBe("2026-10-20");
    expect(defaultPasteDate("2026-10-30")).toBe("2026-10-30");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/ingest/claude-spread.test.ts`
Expected: FAIL — cannot find module `./claude-spread`.

- [ ] **Step 3: Implement**

```ts
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

/** The paste form's default date: Sunday on a Monday (the table includes Monday morning), else today. */
export function defaultPasteDate(today: string): string {
  return new Date(`${today}T00:00:00Z`).getUTCDay() === 1 ? addDays(today, -1) : today;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/ingest/claude-spread.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/claude-spread.ts src/lib/ingest/claude-spread.test.ts
git commit -m "feat(ingest): spread Claude Team month-to-date pastes into daily facts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Keep every paste, rebuild facts (paste, nightly, Data → Sync)

**Files:**
- Create: `src/lib/ingest/run-claude-spend.ts`, `src/components/claude-rebuild.tsx`
- Modify: `src/app/(dashboard)/imports/actions.ts` (`commitClaudeSpendImport` ~line 332; new action after `rebuildCursorMonth` ~line 761), `src/components/claude-spend-import.tsx` (line 19), `src/lib/ingest/run-all.ts` (`runAllSyncs`), `src/lib/sync-sources.ts`, `src/app/(dashboard)/data/sync-tab.tsx`
- Test: `src/lib/ingest/run-claude-spend.test.ts`, existing `src/lib/sync-sources.test.ts`

**Interfaces:**
- Consumes: `spreadClaudeSnapshots`, `ClaudeSnapshotRow` (Task 2); `replaceWindowFacts`, `ResolvedFact` (`persist.ts`).
- Produces:
  - `monthWindow(month: string): { startDate: string; endDate: string }`
  - `recentClaudeMonths(now: Date): string[]` — `[previousMonth, currentMonth]` (`YYYY-MM`).
  - `saveClaudePaste(supabase, asOf: string, rows: ClaudePasteRow[], createdBy: string | null): Promise<number>` with `interface ClaudePasteRow { email: string; employeeId: string | null; mtdGbp: number; mtdUsd: number }`
  - `rebuildClaudeSpend(supabase, months: string[]): Promise<{ rowsWritten: number }>`
  - `claudeSnapshotMonths(supabase): Promise<string[]>`
  - server action `rebuildClaudeTeamSpend(): Promise<{ months: number; written: number }>`
  - runAllSyncs job name `claude_spend`.

- [ ] **Step 1: Write the failing tests for the pure helpers**

`src/lib/ingest/run-claude-spend.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { monthWindow, recentClaudeMonths } from "./run-claude-spend";

describe("monthWindow", () => {
  it("is the month, exclusive end", () => {
    expect(monthWindow("2026-10")).toEqual({ startDate: "2026-10-01", endDate: "2026-11-01" });
    expect(monthWindow("2026-12")).toEqual({ startDate: "2026-12-01", endDate: "2027-01-01" });
  });
});

describe("recentClaudeMonths", () => {
  it("is last month and this month (the nightly self-heal)", () => {
    expect(recentClaudeMonths(new Date("2026-10-20T06:00:00Z"))).toEqual(["2026-09", "2026-10"]);
    expect(recentClaudeMonths(new Date("2027-01-02T06:00:00Z"))).toEqual(["2026-12", "2027-01"]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/ingest/run-claude-spend.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `run-claude-spend.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { pageAll } from "@/lib/notify/store";
import { spreadClaudeSnapshots, type ClaudeSnapshotRow } from "./claude-spread";
import { replaceWindowFacts } from "./persist";

/** One person's line of a Claude Team paste (only non-zero rows are pasted in). */
export interface ClaudePasteRow {
  email: string;
  employeeId: string | null;
  mtdGbp: number;
  mtdUsd: number;
}

const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};

export function monthWindow(month: string): { startDate: string; endDate: string } {
  return { startDate: `${month}-01`, endDate: `${nextMonth(month)}-01` };
}

export function recentClaudeMonths(now: Date): string[] {
  const cur = now.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  return [prev, cur];
}

/**
 * Save one paste (every row dated `asOf`), then rebuild its month. Upsert first, then remove that
 * date's rows for people no longer in it — an empty paste changes nothing (gotcha #4).
 */
export async function saveClaudePaste(supabase: SupabaseClient, asOf: string, rows: ClaudePasteRow[], createdBy: string | null): Promise<number> {
  if (!rows.length) return 0;
  const { error } = await supabase.from("claude_spend_snapshots").upsert(
    rows.map((r) => ({
      as_of: asOf,
      email: r.email,
      employee_id: r.employeeId,
      mtd_gbp: r.mtdGbp,
      usd_per_gbp: r.mtdGbp > 0 ? Math.round((r.mtdUsd / r.mtdGbp) * 1e6) / 1e6 : null,
      mtd_usd: r.mtdUsd,
      created_by: createdBy,
    })),
    { onConflict: "as_of,email" },
  );
  if (error) throw new Error(`saveClaudePaste: ${error.message}`);
  const { data: existing, error: readErr } = await supabase.from("claude_spend_snapshots").select("email").eq("as_of", asOf);
  if (readErr) throw new Error(`saveClaudePaste(read): ${readErr.message}`);
  const keep = new Set(rows.map((r) => r.email));
  const stale = (existing ?? []).map((r) => r.email as string).filter((e) => !keep.has(e));
  if (stale.length) {
    const { error: delErr } = await supabase.from("claude_spend_snapshots").delete().eq("as_of", asOf).in("email", stale);
    if (delErr) throw new Error(`saveClaudePaste(prune): ${delErr.message}`);
  }
  return (await rebuildClaudeSpend(supabase, [asOf.slice(0, 7)])).rowsWritten;
}

/** Rebuild these months' Claude Team usage facts from their pastes. A month with no pastes is left alone. */
export async function rebuildClaudeSpend(supabase: SupabaseClient, months: string[]): Promise<{ rowsWritten: number }> {
  let rowsWritten = 0;
  for (const month of months) {
    const window = monthWindow(month);
    const rows = await pageAll<{ as_of: string; email: string; employee_id: string | null; mtd_usd: number | string }>(
      (a, b) =>
        supabase
          .from("claude_spend_snapshots")
          .select("as_of, email, employee_id, mtd_usd")
          .gte("as_of", window.startDate)
          .lt("as_of", window.endDate)
          .order("as_of")
          .order("email")
          .range(a, b),
      "claude_spend_snapshots",
    );
    if (!rows.length) continue;
    const snaps: ClaudeSnapshotRow[] = rows.map((r) => ({ asOf: r.as_of, email: r.email, employeeId: r.employee_id, mtdUsd: Number(r.mtd_usd) }));
    rowsWritten += await replaceWindowFacts(supabase, "claude_team", window, spreadClaudeSnapshots(snaps, month), { costType: "overage", pruneWhenEmpty: true });
  }
  return { rowsWritten };
}

/** Every month that has a paste (Data → Sync's one-off "rebuild all"). */
export async function claudeSnapshotMonths(supabase: SupabaseClient): Promise<string[]> {
  const rows = await pageAll<{ as_of: string }>(
    (a, b) => supabase.from("claude_spend_snapshots").select("as_of, email").order("as_of").order("email").range(a, b),
    "claude_spend_snapshots(months)",
  );
  return [...new Set(rows.map((r) => r.as_of.slice(0, 7)))];
}
```

(`pruneWhenEmpty: true` is safe here: the month HAS pastes, so an empty spread means every increase was zero.)

- [ ] **Step 4: Run the helper tests**

Run: `npx vitest run src/lib/ingest/run-claude-spend.test.ts`
Expected: PASS

- [ ] **Step 5: Save snapshots from the paste**

In `src/app/(dashboard)/imports/actions.ts`, `commitClaudeSpendImport`: replace the block from `const day = asOf.slice(0, 7) + "-01";` through `const written = await upsertSpendFacts(supabase, facts);` with

```ts
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("Pick the paste's date");
  const pasted = rows.filter((r) => r.usd > 0);
  // Every paste is kept; the month's daily facts are rebuilt from all of them (claude-spread.ts).
  const written = await saveClaudePaste(
    supabase,
    asOf,
    pasted.map((r) => ({ email: r.email, employeeId: r.employeeId, mtdGbp: r.mtdGbp, mtdUsd: r.usd })),
    await actorEmail(),
  );
```

and change the `attributed` / `row_counts` lines below to use `pasted`:

```ts
  const attributed = pasted.filter((r) => r.employeeId).length;
  // …imports.insert unchanged except:
    row_counts: { withSpend: pasted.length, attributed, queued: pasted.length - attributed },
  // …
  return { written, attributed, queued: pasted.length - attributed };
```

Add imports: `import { claudeSnapshotMonths, rebuildClaudeSpend, saveClaudePaste } from "@/lib/ingest/run-claude-spend";` and `actorEmail` from `@/lib/auth-guard` (alongside `requireAdmin`). Remove `upsertSpendFacts` from the persist import only if nothing else in the file uses it (`grep -n upsertSpendFacts` first).

- [ ] **Step 6: Add the rebuild-all action**

After `rebuildCursorMonth`:

```ts
/**
 * Rebuild Claude Team's daily usage from every saved paste (Data → Sync). Run once after the 0024
 * migration so earlier months are spread over their days instead of sitting on the 1st; safe any time.
 */
export async function rebuildClaudeTeamSpend(): Promise<{ months: number; written: number }> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const months = await claudeSnapshotMonths(supabase);
  const { rowsWritten } = await rebuildClaudeSpend(supabase, months);
  updateTag(FACTS_TAG);
  revalidatePath("/data");
  return { months: months.length, written: rowsWritten };
}
```

- [ ] **Step 7: The rebuild button**

`src/components/claude-rebuild.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { rebuildClaudeTeamSpend } from "@/app/(dashboard)/imports/actions";

/** Rebuild Claude Team's daily usage from every saved paste (Data → Sync). */
export function ClaudeRebuild() {
  const [result, setResult] = useState<{ months: number; written: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const onRebuild = () =>
    start(async () => {
      setResult(null);
      setError(null);
      try {
        setResult(await rebuildClaudeTeamSpend());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  return (
    <div className="space-y-3">
      <button onClick={onRebuild} disabled={pending} className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-sm text-accent disabled:opacity-40">
        {pending ? "Rebuilding…" : "Rebuild Claude Team spend"}
      </button>
      {error && <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>}
      {result && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Rebuilt {result.months} {result.months === 1 ? "month" : "months"}: {result.written} daily rows.
        </p>
      )}
    </div>
  );
}
```

In `src/app/(dashboard)/data/sync-tab.tsx` add after the Cursor panel:

```tsx
      <Panel>
        <h2 className="mb-1 text-sm font-medium">Rebuild Claude Team spend</h2>
        <p className="mb-4 text-xs text-muted">
          Spreads every saved Claude Team paste over the days it covers. Run it once after this update so earlier months stop sitting on the 1st; it&rsquo;s safe to run again.
        </p>
        <ClaudeRebuild />
      </Panel>
```

with `import { ClaudeRebuild } from "@/components/claude-rebuild";`.

- [ ] **Step 8: Nightly self-heal and its label**

`src/lib/ingest/run-all.ts`: inside the `Promise.all([...])` add

```ts
    run("claude_spend", () => rebuildClaudeSpend(supabase, recentClaudeMonths(new Date()))),
```

with `import { rebuildClaudeSpend, recentClaudeMonths } from "./run-claude-spend";`.

`src/lib/sync-sources.ts`: add `claude_spend: "Claude Team spend (daily spread)",` after `claude_seats`.

- [ ] **Step 9: Paste form default date**

`src/components/claude-spend-import.tsx` line 19:

```tsx
  const [asOf, setAsOf] = useState(() => defaultPasteDate(localDateISO()));
```

with `import { defaultPasteDate } from "@/lib/ingest/claude-spread";`. Next to the date input add the hint `<span className="text-xs text-muted">Paste every Monday (dated Sunday) and on the month&rsquo;s last working day.</span>`.

- [ ] **Step 10: Run tests**

Run: `npm run test`
Expected: PASS (sync-sources.test confirms the new job has a label).

- [ ] **Step 11: Commit**

```bash
git add src/lib/ingest/run-claude-spend.ts src/lib/ingest/run-claude-spend.test.ts src/app/\(dashboard\)/imports/actions.ts src/components/claude-rebuild.tsx src/components/claude-spend-import.tsx src/lib/ingest/run-all.ts src/lib/sync-sources.ts src/app/\(dashboard\)/data/sync-tab.tsx
git commit -m "feat(imports): keep every Claude Team paste and rebuild its daily spread

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Claude Team becomes ordinary daily usage (retire the month-lump path)

Claude Team was the only `MONTHLY_SNAPSHOT_SOURCES` member; with daily facts the lump handling (amortising over 1st → as-of, snapshot pacing in projections, `snapshotAsOf` everywhere) is dead. Remove it; leave Claude Team out of **daily** digests only.

**Files:**
- Modify: `src/lib/explore/shape.ts`, `src/lib/explore/project.ts`, `src/lib/explore/build.ts`, `src/lib/queries/explore.ts`, `src/lib/queries/cached.ts`, `src/lib/notify/context.ts`, `src/lib/notify/store.ts`, `src/lib/notify/memory-store.ts`, `src/lib/notify/digest.ts`
- Test: `src/lib/explore/shape.test.ts`, `src/lib/explore/project.test.ts`, `src/lib/explore/build.test.ts`, `src/lib/explore/trends.test.ts`, `src/lib/notify/digest.test.ts`

**Interfaces:**
- Produces: `SPREAD_SOURCES: ReadonlySet<string>` (shape.ts) = `{"claude_team"}`; `isMonthlyLevelFact(f)` = seat or subscription only; `trendForPeriod(rows, period, dim)` (3 params); `projectPeriodEnd(facts, now, period, sourceHorizons?)`, `projectTrendForPeriod(…, sourceHorizons?)`, and the third projector each lose their trailing `snapshotAsOf` param; Explore scopes and `NotifyContext` lose `snapshotAsOf`; `NotifyStore` loses `snapshotAsOf()`.

- [ ] **Step 1: Rewrite the tests to the new truth (they fail first)**

`src/lib/explore/shape.test.ts`: replace the whole `describe("month-to-date snapshot usage (Claude Team paste)", …)` block with

```ts
  describe("Claude Team usage (a daily spread of its pastes)", () => {
    const rows2: ShapeFact[] = [
      { day: "2026-06-03", source: "claude_team", costType: "overage", costUsd: 70, employeeId: "b", department: "Eng", fullName: "B", entityKey: "b@x", model: "" },
      { day: "2026-06-01", source: "claude_team", costType: "seat", costUsd: 300, employeeId: "b", department: "Eng", fullName: "B", entityKey: "b@x", model: "" },
    ];
    it("lands on its own day, like any usage", () => {
      const t = trendForPeriod(rows2, parsePeriod("2026-06", NOW2), "cost_type");
      expect(t.find((p) => p.label === "3")?.overage).toBeCloseTo(70, 6);
      expect(t.find((p) => p.label === "4")?.overage).toBeUndefined();
    });
    it("its seats still spread across the whole month", () => {
      const t = trendForPeriod(rows2, parsePeriod("2026-06", NOW2), "cost_type");
      expect(t.find((p) => p.label === "30")?.seat).toBeCloseTo(10, 6);
    });
  });
```

`src/lib/explore/project.test.ts`: delete the test `"monthly-snapshot usage (Claude Team import) is a level, not a daily rate"` and the whole `describe("Claude Team's month-to-date paste", …)`; add

```ts
describe("Claude Team's daily spread", () => {
  it("projects at its pace like any daily usage", () => {
    const days = Array.from({ length: 10 }, (_, i) => fact(`2026-07-${String(i + 1).padStart(2, "0")}`, "overage", 100, "claude_team"));
    // pace $100/day over 1–10 Jul (the horizon), no prior month: 1000 + 100 × 21
    expect(projectPeriodEnd(days, NOW, MONTH, { claude_team: "2026-07-10" })!.projectedUsd).toBeCloseTo(3100, 0);
  });
});
```

`src/lib/explore/build.test.ts`: delete `"draws a month-to-date snapshot only up to its import's as-of day"` and `"projects a month-to-date paste at its pace, using the scope's as-of days"`; remove `snapshotAsOf: {}` from the scope fixture (line ~17). `src/lib/explore/trends.test.ts`: remove `snapshotAsOf: {},` from both fixtures.

`src/lib/notify/digest.test.ts`:
- line ~34 comment → `// Claude Team, dated the 1st: outside the week`
- test title `"excludes Claude Team's monthly lump and person-less facts from reports"` → `"leaves out facts outside the week and person-less facts from reports"`
- replace `describe("month line with a month-to-date paste", …)` with

```ts
describe("Claude Team's daily spread", () => {
  const spread = [fact("2026-09-22", "claude_team", "overage", 5, "m"), fact("2026-09-23", "claude_team", "overage", 5, "m")];
  it("counts in a weekly", () => {
    expect(buildDigest(input({ facts: spread, reportIds: [] }))!.you.headlineUsd).toBe(10);
  });
  it("is left out of a daily (an even split is invented for a single day)", () => {
    const d = buildDigest(input({ facts: spread, reportIds: [], period: periodFor("daily", "2026-09-22", now) }));
    expect(d?.you.headlineUsd ?? 0).toBe(0);
  });
});
```

- line ~401 comment → `// Claude Team, dated the 1st: outside the week`

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/lib/explore src/lib/notify/digest.test.ts`
Expected: FAIL (e.g. the daily digest still counts Claude Team; trendForPeriod still amortises it).

- [ ] **Step 3: shape.ts**

Delete `MONTHLY_SNAPSHOT_SOURCES`, the `SnapshotAsOf` type and their comments. Replace `isMonthlyLevelFact` and add `SPREAD_SOURCES`:

```ts
/**
 * Facts that represent a MONTHLY cost posted as a single fact stamped to the 1st: seats and
 * subscriptions. The projection treats them as a monthly level; day/week trend charts amortise them
 * across the month instead of spiking the 1st.
 */
export function isMonthlyLevelFact(f: ShapeFact): boolean {
  return f.costType === "seat" || f.costType === "subscription";
}

/**
 * Sources whose day-level figures are an even spread of a longer paste (Claude Team:
 * ingest/claude-spread.ts) — fair over a week, invented for a single day.
 */
export const SPREAD_SOURCES: ReadonlySet<string> = new Set(["claude_team"]);
```

`trendForPeriod`: signature `export function trendForPeriod(rows: ShapeFact[], period: Period, dim: Dim): TrendPoint[]`; in the amortise branch delete the `isFee` and `asOf` lines and use `const days = monthDays;`; delete the doc-comment sentence about `snapshotAsOf`.

- [ ] **Step 4: project.ts**

- import becomes `import { isMonthlyLevelFact, type ShapeFact } from "./shape";`
- delete `isSnapshotUsage`, the `snapshotSources` function, `pacedSnapshots` and its comment;
- `const levelUsd = sum(inMonth.filter(isMonthlyLevel));`
- delete `if (pacedSnapshots) sources.push(...snapshotSources(...));`
- `function monthModel(facts: ShapeFact[], now: Date, sourceHorizons?: Record<string, string>): MonthModel | null`
- in the three exported projectors (`projectPeriodEnd` ~278, and the two at ~354 and ~389) delete the `snapshotAsOf?: SnapshotAsOf,` parameter and pass `monthModel(facts, now, sourceHorizons)`.

- [ ] **Step 5: build.ts, queries/explore.ts, cached.ts**

- build.ts: drop `type SnapshotAsOf` from the import; drop `; snapshotAsOf: SnapshotAsOf` from the three `RawScope` variants; calls become `trendForPeriod(scope.facts, period, d)`, `projectPeriodEnd(scope.facts, now, period, scope.horizons)`, `projectTrendForPeriod(scope.facts, now, period, scope.horizons)`.
- queries/explore.ts: delete `getSnapshotAsOf` and its doc comment; import becomes `import { UNATTRIBUTED, type ShapeFact } from "@/lib/explore/shape";`; in the company, team and person loaders remove `getSnapshotAsOf(supabase)` from each `Promise.all`, `snapshotAsOf` from each destructuring and from each returned scope.
- cached.ts: `const CACHE_VERSION = "v8"; // v8: Explore scopes lost snapshotAsOf (Claude Team is daily-spread now)` — **same commit** (scope shape change).

- [ ] **Step 6: notify — context, store, memory-store, digest**

- context.ts: remove `SnapshotAsOf` from the import, the `snapshotAsOf` field (line ~20), `store.snapshotAsOf()` and its destructured name from the `Promise.all` (line ~50–54), the `snapshotAsOf,` assignment (~68) and `snapshotAsOf: ctx.snapshotAsOf,` (~84).
- store.ts: remove `snapshotAsOf(): Promise<SnapshotAsOf>;`, its implementation, `getSnapshotAsOf` from the explore import and the `SnapshotAsOf` type import.
- memory-store.ts: remove the `snapshotAsOf` seed field and method.
- digest.ts: remove `SnapshotAsOf` from the import and `snapshotAsOf?: SnapshotAsOf;` from `SectionInput`; `monthContext` destructuring drops it and calls `projectPeriodEnd(pop, now, {…}, sourceHorizons)`. In `counted`, replace `if (isMonthlyLevelFact(f)) return monthly ? [f] : [];` with

```ts
    if (SPREAD_SOURCES.has(f.source)) return period.cadence === "daily" ? [] : [f];
```

import `SPREAD_SOURCES` (drop `isMonthlyLevelFact` if now unused), and update `counted`'s doc bullet to: "Claude Team's spread pastes in weekly and monthly, never daily (an even split is invented for a single day);".

- [ ] **Step 7: Run everything**

Run: `npm run test` then `npx tsc --noEmit`
Expected: PASS, no type errors (fix any leftover `snapshotAsOf` reference the compiler names).

- [ ] **Step 8: Commit**

```bash
git add -A src/lib/explore src/lib/queries src/lib/notify
git commit -m "refactor(explore): Claude Team is daily usage now; retire the month-lump path

CACHE_VERSION v8: Explore scopes no longer carry snapshotAsOf.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Week readiness (pure) and the store reads it needs

**Files:**
- Create: `src/lib/notify/readiness.ts`, `src/lib/notify/readiness.test.ts`
- Modify: `src/lib/notify/store.ts` (interface + Supabase impl), `src/lib/notify/memory-store.ts`

**Interfaces:**
- Consumes: `SYNCED_SOURCES`, `SyncRunRow` (`freshness.ts`); `VENDOR_LABEL`, `Vendor` (`@/lib/types`).
- Produces:
  - `READINESS_SYNC_DAYS = 14`; `readinessSyncSince(now: Date): string` (ISO, start of the UTC day 14 days back)
  - `interface ManualImportRow { source: string; kind: string; dataAsOf: string }`
  - `type Outstanding = { kind: "sync"; source: Vendor; lastSuccessDay: string | null } | { kind: "chatgptCredits"; through: string } | { kind: "claudeSpend"; asOf: string }`
  - `interface Readiness { ready: boolean; outstanding: Outstanding[] }`
  - `syncsOutstanding(runs: SyncRunRow[], sinceDay: string): Outstanding[]`
  - `importsInUseSince(day: string): string` — first day of the month two months before `day`'s
  - `weekReadiness(a: { week: { from: string; toExclusive: string }; syncRuns: SyncRunRow[]; imports: ManualImportRow[] }): Readiness`
  - `outstandingShort(o: Outstanding): string` — e.g. "Claude Team (pasted as of 11 Oct)"
  - `NotifyStore.manualImports(sinceDay: string): Promise<ManualImportRow[]>`; memory seed `manualImports?: ManualImportRow[]`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { SyncRunRow } from "./freshness";
import { importsInUseSince, outstandingShort, readinessSyncSince, syncsOutstanding, weekReadiness, type ManualImportRow } from "./readiness";

const WEEK = { from: "2026-10-12", toExclusive: "2026-10-19" }; // Mon 12 – Sun 18 Oct
const ok = (source: string, startedAt: string): SyncRunRow => ({ source, status: "success", startedAt });
const bad = (source: string, startedAt: string): SyncRunRow => ({ source, status: "failed", startedAt });
const imp = (source: string, kind: string, dataAsOf: string): ManualImportRow => ({ source, kind, dataAsOf });
const runs = [ok("cursor", "2026-10-19T06:00:00Z"), ok("anthropic", "2026-10-19T06:00:00Z")];
const imports = [imp("chatgpt_business", "csv", "2026-10-18"), imp("claude_team", "clipboard", "2026-10-18")];

describe("weekReadiness", () => {
  it("is ready once every source in use synced since the week ended and both imports reach Sunday", () => {
    expect(weekReadiness({ week: WEEK, syncRuns: runs, imports })).toEqual({ ready: true, outstanding: [] });
  });

  it("waits for a source that failed since the week ended", () => {
    const r = weekReadiness({ week: WEEK, syncRuns: [...runs, ok("openai", "2026-10-17T06:00:00Z"), bad("openai", "2026-10-19T06:00:00Z")], imports });
    expect(r.outstanding).toEqual([{ kind: "sync", source: "openai", lastSuccessDay: "2026-10-17" }]);
  });

  it("ignores a source with no success in the window (not set up)", () => {
    expect(weekReadiness({ week: WEEK, syncRuns: [...runs, bad("vercel", "2026-10-19T06:00:00Z")], imports }).ready).toBe(true);
  });

  it("nothing synced at all is not ready", () => {
    const r = weekReadiness({ week: WEEK, syncRuns: [], imports });
    expect(r.ready).toBe(false);
    expect(r.outstanding.every((o) => o.kind === "sync")).toBe(true);
  });

  it("waits for ChatGPT credits through Sunday and a Claude Team paste as of Sunday", () => {
    const r = weekReadiness({ week: WEEK, syncRuns: runs, imports: [imp("chatgpt_business", "csv", "2026-10-11"), imp("claude_team", "clipboard", "2026-10-11")] });
    expect(r.outstanding).toEqual([{ kind: "chatgptCredits", through: "2026-10-11" }, { kind: "claudeSpend", asOf: "2026-10-11" }]);
  });

  it("a paste dated after Sunday counts", () => {
    expect(weekReadiness({ week: WEEK, syncRuns: runs, imports: [imp("claude_team", "clipboard", "2026-10-19")] }).ready).toBe(true);
  });

  it("an import nobody has used in two months isn't required", () => {
    expect(weekReadiness({ week: WEEK, syncRuns: runs, imports: [imp("chatgpt_business", "csv", "2026-07-31")] }).ready).toBe(true);
  });

  it("a week straddling two months needs the paste as of its Sunday", () => {
    const w = { from: "2026-10-26", toExclusive: "2026-11-02" };
    const r2 = [ok("cursor", "2026-11-02T06:00:00Z")];
    expect(weekReadiness({ week: w, syncRuns: r2, imports: [imp("claude_team", "clipboard", "2026-11-01")] }).ready).toBe(true);
    expect(weekReadiness({ week: w, syncRuns: r2, imports: [imp("claude_team", "clipboard", "2026-10-31")] }).outstanding).toEqual([{ kind: "claudeSpend", asOf: "2026-10-31" }]);
  });

  it("ignores roster uploads and failed imports' kinds it doesn't know", () => {
    expect(weekReadiness({ week: WEEK, syncRuns: runs, imports: [imp("chatgpt_business", "roster", "2026-10-01")] }).ready).toBe(true);
  });
});

describe("helpers", () => {
  it("syncsOutstanding lists in-use sources without a success since the day", () => {
    expect(syncsOutstanding([ok("cursor", "2026-10-18T06:00:00Z")], "2026-10-19")).toEqual([{ kind: "sync", source: "cursor", lastSuccessDay: "2026-10-18" }]);
  });
  it("importsInUseSince is two months back, from the 1st", () => {
    expect(importsInUseSince("2026-10-18")).toBe("2026-08-01");
    expect(importsInUseSince("2027-01-03")).toBe("2026-11-01");
  });
  it("readinessSyncSince is 14 days back, from midnight UTC", () => {
    expect(readinessSyncSince(new Date("2026-10-19T09:30:00Z"))).toBe("2026-10-05T00:00:00.000Z");
  });
  it("outstandingShort names each item", () => {
    expect(outstandingShort({ kind: "claudeSpend", asOf: "2026-10-11" })).toBe("Claude Team (pasted as of 11 Oct)");
    expect(outstandingShort({ kind: "chatgptCredits", through: "2026-10-11" })).toBe("ChatGPT credits (through 11 Oct)");
    expect(outstandingShort({ kind: "sync", source: "openai", lastSuccessDay: null })).toBe("OpenAI API sync");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/notify/readiness.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `readiness.ts`**

```ts
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
```

- [ ] **Step 4: Store reads**

`store.ts` — interface (after `importCoverage`):

```ts
  /** Successful ChatGPT credits / Claude Team imports dated on or after `sinceDay` (readiness.ts). */
  manualImports(sinceDay: string): Promise<ManualImportRow[]>;
```

implementation in `supabaseNotifyStore`:

```ts
    async manualImports(sinceDay) {
      const rows = await pageAll<{ source: string; kind: string; data_as_of: string }>(
        (a, b) =>
          supabase
            .from("imports")
            .select("source, kind, data_as_of")
            .eq("status", "success")
            .in("source", ["chatgpt_business", "claude_team"])
            .gte("data_as_of", sinceDay)
            .order("data_as_of")
            .order("id")
            .range(a, b),
        "manualImports",
      );
      return rows.map((r) => ({ source: r.source, kind: r.kind, dataAsOf: r.data_as_of }));
    },
```

(import `type ManualImportRow` from `./readiness`). `memory-store.ts`: seed field `manualImports?: ManualImportRow[];` and

```ts
    manualImports: async (since) => (seed.manualImports ?? []).filter((r) => r.dataAsOf >= since),
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lib/notify` and `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/notify/readiness.ts src/lib/notify/readiness.test.ts src/lib/notify/store.ts src/lib/notify/memory-store.ts
git commit -m "feat(notify): week readiness — syncs, ChatGPT credits and the Claude Team paste

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `dueDigests` by readiness, no forced monthlies

**Files:**
- Modify: `src/lib/notify/schedule.ts` (`MONTHLY_WINDOW`, `monthlyLastDay`, `DueDigest`, `dueDigests`)
- Test: `src/lib/notify/schedule.test.ts`

**Interfaces:**
- Produces: `MONTHLY_WINDOW = { firstDay: 3 }`; `inMonthlyWindow(day: string): boolean` (day of month ≥ 3); `interface DueDigest { period: DigestPeriod }`; `dueDigests(day: string, ready: { week: boolean; month: boolean }): DueDigest[]`. `monthlyLastDay` is deleted.

- [ ] **Step 1: Rewrite the dueDigests tests**

In `schedule.test.ts` change the helper and the `describe("dueDigests")` block (delete any `monthlyLastDay` test and import):

```ts
const due = (day: string, ready = { week: true, month: true }) => dueDigests(day, ready).map((d) => `${d.period.cadence}:${d.period.key}`);

describe("dueDigests", () => {
  it("nothing at all on Saturday or Sunday", () => {
    expect(due("2026-10-03")).toEqual([]);
    expect(due("2026-10-04")).toEqual([]);
  });
  it("the day before every working day (Monday: Friday)", () => {
    expect(due("2026-09-30", { week: false, month: false })).toEqual(["daily:2026-09-29"]);
    expect(due("2026-09-28", { week: false, month: false })).toEqual(["daily:2026-09-25"]);
  });
  it("the latest complete week on any working day once it's ready, not before", () => {
    expect(due("2026-09-28", { week: true, month: false })).toEqual(["daily:2026-09-25", "weekly:2026-W39"]);
    expect(due("2026-10-02", { week: true, month: false })).toEqual(["daily:2026-10-01", "weekly:2026-W39"]); // Friday
    expect(due("2026-10-02", { week: false, month: false })).toEqual(["daily:2026-10-01"]);
  });
  it("last month's recap from the 3rd to the month's end once ready — never forced", () => {
    expect(due("2026-10-02", { week: false, month: true })).toEqual(["daily:2026-10-01"]); // before the 3rd
    expect(due("2026-11-03", { week: false, month: true })).toEqual(["daily:2026-11-02", "monthly:2026-10"]);
    expect(due("2026-11-03", { week: false, month: false })).toEqual(["daily:2026-11-02"]);
    expect(due("2026-10-27", { week: false, month: true })).toEqual(["daily:2026-10-26", "monthly:2026-09"]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/notify/schedule.test.ts`
Expected: FAIL (`dueDigests` still takes a boolean / adds `force`).

- [ ] **Step 3: Implement**

Replace `MONTHLY_WINDOW`'s comment and value, delete `monthlyLastDay`, and replace `DueDigest`/`dueDigests`:

```ts
/**
 * Monthly recaps go out once ready, on any working day from the 3rd (monthToDate re-syncs the
 * previous month through the 3rd, so automatic sources aren't final before then) to the month's end.
 * Never forced: an incomplete month waits.
 */
export const MONTHLY_WINDOW = { firstDay: 3 } as const;

export const inMonthlyWindow = (day: string) => Number(day.slice(8, 10)) >= MONTHLY_WINDOW.firstDay;

export interface DueDigest {
  period: DigestPeriod;
}

/**
 * What may go out on a recipient's local working `day`: the previous working day's daily (Monday
 * carries Friday); the latest complete week's weekly once that week is ready (any working day —
 * a week not ready by Friday is skipped, as Monday moves on); last month's recap once ready.
 */
export function dueDigests(day: string, ready: { week: boolean; month: boolean }): DueDigest[] {
  if (!isWorkingDay(day)) return [];
  const now = new Date(`${day}T12:00:00Z`); // a moment inside that day, for the period helpers
  const out: DueDigest[] = [{ period: periodFor("daily", previousWorkingDay(day), now) }];
  if (ready.week) out.push({ period: periodFor("weekly", latestCompleteKey("weekly", now), now) });
  if (ready.month && inMonthlyWindow(day)) out.push({ period: periodFor("monthly", latestCompleteKey("monthly", now), now) });
  return out;
}
```

- [ ] **Step 4: Run schedule tests**

Run: `npx vitest run src/lib/notify/schedule.test.ts`
Expected: PASS. (`run-notify.ts` won't compile until Task 7 — don't commit yet if `npx tsc --noEmit` fails; Task 7 completes the change. Commit Tasks 6 and 7 together at the end of Task 7.)

---

### Task 7: The run sends only what's ready

**Files:**
- Modify: `src/lib/notify/run-notify.ts` (imports; `RunNotifyResult`; step 2 ~lines 122–145)
- Test: `src/lib/notify/run-notify.test.ts`

**Interfaces:**
- Consumes: Task 5 (`weekReadiness`, `syncsOutstanding`, `readinessSyncSince`, `importsInUseSince`, `store.manualImports`), Task 6 (`dueDigests(day, ready)`, `inMonthlyWindow`, `periodFor`, `latestCompleteKey`).
- Produces: `RunNotifyResult.held: string[]` (e.g. `"weekly:2026-W42"`); exported `claim` and `errorDetail` (reused by Task 8):
  - `export async function claim(store: NotifyStore, key: SendKey, result: { alreadyHandled: number; failed: number }, log: (m: string) => void): Promise<string | null>`
  - `export const errorDetail: (err: unknown) => string`

- [ ] **Step 1: Write the failing run tests**

Add to `run-notify.test.ts` (inside `describe("runNotify")`):

```ts
  describe("only when the week is complete", () => {
    const WED = new Date("2026-09-30T09:30:00Z"); // 10:30 BST Wednesday
    const claudeAsOf = (d: string) => [{ source: "claude_team", kind: "clipboard", dataAsOf: d }];

    it("holds the weekly until Claude Team is pasted as of Sunday, then sends it midweek", async () => {
      const seedImports = claudeAsOf("2026-09-20");
      const store = memoryStore(seed({ manualImports: seedImports }), () => MONDAY.getTime());
      const slack = fakeSlack();
      const mon = await runNotify(deps(store, slack.client));
      expect(mon.held).toEqual(["weekly:2026-W39"]);
      expect(store.sends.some((s) => s.cadence === "weekly")).toBe(false);

      seedImports.push({ source: "claude_team", kind: "clipboard", dataAsOf: "2026-09-27" });
      const runs = [{ source: "cursor", status: "success", startedAt: "2026-09-30T06:00:03Z" }];
      const wedStore = memoryStore(seed({ manualImports: seedImports, syncRuns: runs, sends: store.sends }), () => WED.getTime());
      const wed = await runNotify(deps(wedStore, slack.client, { now: WED, clock: () => WED.getTime() }));
      expect(wed.due).toContain("weekly:2026-W39");
      expect(wedStore.sends.find((s) => s.cadence === "weekly" && s.employeeId === "m")).toMatchObject({ status: "sent", periodKey: "2026-W39" });
    });

    it("skips a week that wasn't ready by Friday: the next Monday moves on", async () => {
      const NEXT_MON = new Date("2026-10-05T09:30:00Z");
      const store = memoryStore(
        seed({ manualImports: claudeAsOf("2026-10-04"), syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-10-05T06:00:03Z" }] }),
        () => NEXT_MON.getTime(),
      );
      const r = await runNotify(deps(store, fakeSlack().client, { now: NEXT_MON, clock: () => NEXT_MON.getTime() }));
      expect(r.due).toContain("weekly:2026-W40");
      expect(store.sends.some((s) => s.periodKey === "2026-W39")).toBe(false);
    });
  });
```

Update existing tests that this change affects:
- `"skips daily/weekly entirely when no source synced today"` keeps passing (nothing synced → week not ready) — keep its regex.
- `"reads import coverage only on days a monthly could be due"`: coverage is now read only when a **monthly subscriber** is a candidate on a day from the 3rd. Rewrite:

```ts
    it("reads import coverage only when someone's monthly could be due", async () => {
      const store = memoryStore(seed(), () => MONDAY.getTime()); // no monthly subscribers
      await runNotify(deps(store, fakeSlack().client));
      expect(store.coverageCalls).toHaveLength(0);
      const monthly = (over: MemorySeed = {}) => seed({ subscriptions: [{ employeeId: "a", cadence: "monthly" }], ...over });
      const early = memoryStore(monthly({ syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-10-02T06:00:03Z" }] }), () => MONDAY.getTime());
      await runNotify(deps(early, fakeSlack().client, at("2026-10-02T09:30:00Z"))); // the 2nd: before the window
      expect(early.coverageCalls).toHaveLength(0);
      const oct = memoryStore(monthly({ syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-10-05T06:00:03Z" }] }), () => MONDAY.getTime());
      await runNotify(deps(oct, fakeSlack().client, at("2026-10-05T09:30:00Z")));
      expect(oct.coverageCalls).toHaveLength(1);
    });
```

- Any other test whose expected `due`/counts change because monthly recaps are now due on MONDAY (28 Sep ≥ the 3rd) for a **monthly subscriber** with empty coverage: update the expectation to include `"monthly:2026-08"` and the extra send (run the suite and fix each named failure; the first-message test with a daily + monthly subscriber is one).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/lib/notify/run-notify.test.ts`
Expected: FAIL (`held` undefined; weekly not held).

- [ ] **Step 3: Implement**

Imports:

```ts
import { monthlyReadiness, syncSucceededSince } from "./freshness";
import { importsInUseSince, readinessSyncSince, syncsOutstanding, weekReadiness } from "./readiness";
import { dueDigests, inMonthlyWindow, latestCompleteKey, periodFor, sendDay, type DigestPeriod, type DueDigest } from "./schedule";
```

`RunNotifyResult` gains `/** Weeklies/monthlies someone is waiting for whose data isn't complete yet. */ held: string[];` and the initial result gets `held: []`; the `done()` log adds `held=${result.held.join(",")}`.

Export the two helpers (`export const errorDetail = …`, `export async function claim(store: NotifyStore, key: SendKey, result: { alreadyHandled: number; failed: number }, log: (m: string) => void)` — body unchanged).

Replace step 2 (from `// 2. What's due on each of those days` through `result.due = …`) with:

```ts
  // 2. What's due on each of those days. Weeklies and monthlies go only once their data is complete
  //    (readiness.ts); a daily still waits for that day's sync. Import coverage pages through every
  //    manual-source fact, so it's read only when someone's monthly could be due.
  const days = [...new Set(candidates.map((c) => c.day))].sort();
  const wants = (day: string, cadence: Cadence) => candidates.some((c) => c.day === day && c.cadence === cadence);
  const monthlyWanted = days.some((d) => inMonthlyWindow(d) && wants(d, "monthly"));
  const coverage = monthlyWanted ? await store.importCoverage(now.toISOString().slice(0, 7)) : [];
  const syncRuns = await store.recentSyncRuns(readinessSyncSince(now));
  const imports = days.some((d) => wants(d, "weekly")) ? await store.manualImports(importsInUseSince(addDays(days[0], -7))) : [];
  const dueByDay = new Map<string, DueDigest[]>();
  for (const day of days) {
    const at = new Date(`${day}T12:00:00Z`);
    const week = periodFor("weekly", latestCompleteKey("weekly", at), at);
    const prevMonth = latestCompleteKey("monthly", at);
    const weekReady = wants(day, "weekly") && weekReadiness({ week, syncRuns, imports }).ready;
    const monthReady =
      wants(day, "monthly") && inMonthlyWindow(day) && monthlyReadiness(coverage, prevMonth).ready && syncsOutstanding(syncRuns, `${day.slice(0, 7)}-01`).length === 0;
    if (wants(day, "weekly") && !weekReady) result.held.push(`weekly:${week.key}`);
    if (wants(day, "monthly") && inMonthlyWindow(day) && !monthReady) result.held.push(`monthly:${prevMonth}`);
    let due = dueDigests(day, { week: weekReady, month: monthReady });
    if (!syncSucceededSince(syncRuns, day)) {
      // The daily covers yesterday: it waits for today's sync. Weeklies/monthlies have their own check.
      const kept = due.filter((d) => d.period.cadence !== "daily");
      if (kept.length < due.length) result.note = `no source has synced since ${day} began — daily held`;
      due = kept;
    }
    dueByDay.set(day, due);
  }
  result.held = [...new Set(result.held)];
  result.due = [...new Set([...dueByDay.values()].flat().map((d) => `${d.period.cadence}:${d.period.key}`))];
```

Add the helper near the top: `const addDays = (d: string, n: number) => new Date(Date.parse(\`${d}T00:00:00Z\`) + n * 86_400_000).toISOString().slice(0, 10);`. Remove the now-unused `MONTHLY_WINDOW`/`monthlyLastDay` imports. `loadNotifyContext(store, now, deps.baseUrl, { coverage, syncRuns, employees })` is unchanged (it gets the 14-day runs; `sourceFreshness` reads the latest run per source either way).

- [ ] **Step 4: Run tests and types**

Run: `npm run test` and `npx tsc --noEmit`
Expected: PASS after updating the affected expectations named in Step 1.

- [ ] **Step 5: Commit Tasks 6 + 7**

```bash
git add src/lib/notify/schedule.ts src/lib/notify/schedule.test.ts src/lib/notify/run-notify.ts src/lib/notify/run-notify.test.ts
git commit -m "feat(notify): weeklies and monthlies go only once their data is complete

Weekly due any working day once the week is ready (skipped if not by Friday); monthly
never forced; the daily alone waits for the day's sync.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Reminders — timing, messages, sending

**Files:**
- Create: `src/lib/notify/reminders.ts`, `src/lib/notify/reminders.test.ts`, `src/lib/notify/run-reminders.ts`, `src/lib/notify/run-reminders.test.ts`
- Modify: `src/lib/notify/types.ts`, `src/lib/notify/schedule.ts` (+ `schedule.test.ts`), `src/lib/notify/store.ts`, `src/lib/notify/memory-store.ts`, `src/lib/notify/run-notify.ts` (`who`), `src/app/api/cron/notify/route.ts`

**Interfaces:**
- Consumes: Task 5 (`Outstanding`, `weekReadiness`, `readinessSyncSince`, `importsInUseSince`), Task 7 (`claim`, `errorDetail`), `deliverRendered`, `resolveSlackUser`, `PostOutcomeUnknownError` (`deliver.ts`), `monthlyReadiness` (`freshness.ts`).
- Produces:
  - `types.ts`: `export type SendReport = ReportKind | "reminder";` and `SendKey.report: SendReport` (store.ts).
  - `schedule.ts`: `WEEKLY_REMINDER_AT = 9 * 60 + 30`, `MONTH_END_REMINDER_AT = 15 * 60`, `lastWorkingDay(month: string): string`, `interface DueReminder { kind: "weekly" | "monthEnd"; cadence: "weekly" | "monthly"; periodKey: string; day: string }`, `dueReminders(now: Date, tz: string | null, opts?: { anyTime?: boolean }): DueReminder[]`
  - `reminders.ts`: `weeklyReminder(i: WeeklyReminderInput): RenderedDigest`, `monthEndReminder(i: { monthName: string; importsUrl: string }): RenderedDigest`
  - `run-reminders.ts`: `runReminders(deps: RunNotifyDeps): Promise<RunRemindersResult>`; `RunRemindersResult { due: string[]; sent: number; failed: number; alreadyHandled: number; waiting: number }`
  - `NotifyStore.reminderRecipients(): Promise<string[]>`; memory seed `reminderRecipients?: string[]`; `everLive` counts only `personal`/`company`.

- [ ] **Step 1: Timing tests (schedule.test.ts)**

```ts
describe("dueReminders", () => {
  const keys = (now: string, tz: string | null = "Europe/London") => dueReminders(new Date(now), tz).map((r) => `${r.kind}:${r.periodKey}`);
  it("Monday from 09:30 local: the weekly reminder for the week just ended", () => {
    expect(keys("2026-10-19T08:29:00Z")).toEqual([]); // 09:29 BST
    expect(keys("2026-10-19T08:30:00Z")).toEqual(["weekly:2026-W42"]);
    expect(keys("2026-10-20T08:30:00Z")).toEqual([]); // Tuesday
  });
  it("east of UTC, Monday 09:30 is still Sunday in UTC — the week is the recipient's", () => {
    expect(keys("2026-10-18T22:30:00Z", "Australia/Sydney")).toEqual(["weekly:2026-W42"]); // Mon 09:30 AEDT
  });
  it("the month's last working day from 15:00: the Claude Team month-end reminder", () => {
    expect(keys("2026-10-30T14:59:00Z")).toEqual([]); // 14:59 GMT, Fri 30 Oct (31st is a Saturday)
    expect(keys("2026-10-30T15:00:00Z")).toEqual(["monthEnd:2026-10"]);
    expect(keys("2026-11-30T15:00:00Z")).toEqual(["weekly:2026-W48", "monthEnd:2026-11"]); // a Monday: both
  });
  it("lastWorkingDay skips a weekend end", () => {
    expect(lastWorkingDay("2026-10")).toBe("2026-10-30");
    expect(lastWorkingDay("2026-11")).toBe("2026-11-30");
  });
  it("anyTime (a ?date= replay) ignores the clock", () => {
    expect(dueReminders(new Date("2026-10-19T00:05:00Z"), "Europe/London", { anyTime: true }).map((r) => r.kind)).toEqual(["weekly"]);
  });
});
```

- [ ] **Step 2: Implement timing in schedule.ts**

Refactor `sendDay`'s zone fallback into a helper and add:

```ts
function localSafe(now: Date, tz: string | null): { day: string; minutes: number } {
  try {
    return localClock(now, tz ?? DEFAULT_TZ);
  } catch {
    return localClock(now, DEFAULT_TZ); // RangeError: a zone this runtime doesn't know
  }
}
// sendDay becomes: const local = localSafe(now, tz); return isWorkingDay(local.day) && local.minutes >= SEND_AT_MINUTES ? local.day : null;

/** Reminders: Monday 09:30 (an hour before summaries) and the month's last working day 15:00, local time. */
export const WEEKLY_REMINDER_AT = 9 * 60 + 30;
export const MONTH_END_REMINDER_AT = 15 * 60;

export function lastWorkingDay(month: string): string {
  const [y, m] = month.split("-").map(Number);
  let d = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

export interface DueReminder {
  kind: "weekly" | "monthEnd";
  cadence: "weekly" | "monthly"; // the send log's cadence column
  periodKey: string; // the week's ISO key / the month
  day: string; // the recipient's local day
}

export function dueReminders(now: Date, tz: string | null, opts: { anyTime?: boolean } = {}): DueReminder[] {
  const local = localSafe(now, tz);
  if (!isWorkingDay(local.day)) return [];
  const at = (min: number) => opts.anyTime || local.minutes >= min;
  const out: DueReminder[] = [];
  if (weekday(local.day) === 1 && at(WEEKLY_REMINDER_AT)) {
    out.push({ kind: "weekly", cadence: "weekly", periodKey: latestCompleteKey("weekly", new Date(`${local.day}T12:00:00Z`)), day: local.day });
  }
  if (local.day === lastWorkingDay(local.day.slice(0, 7)) && at(MONTH_END_REMINDER_AT)) {
    out.push({ kind: "monthEnd", cadence: "monthly", periodKey: local.day.slice(0, 7), day: local.day });
  }
  return out;
}
```

Run: `npx vitest run src/lib/notify/schedule.test.ts` → PASS.

- [ ] **Step 3: Message tests (reminders.test.ts)**

```ts
import { describe, expect, it } from "vitest";
import { monthEndReminder, weeklyReminder } from "./reminders";

const base = { week: { label: "12–18 Oct 2026", lastDay: "2026-10-18" }, monthly: null, waiting: 24, importsUrl: "https://x.test/data?tab=imports" };
const text = (r: { blocks: unknown[] }) => JSON.stringify(r.blocks);

describe("weeklyReminder", () => {
  it("lists what's outstanding, how many summaries wait, and links to Imports", () => {
    const r = weeklyReminder({
      ...base,
      outstanding: [
        { kind: "claudeSpend", asOf: "2026-10-11" },
        { kind: "chatgptCredits", through: "2026-10-11" },
        { kind: "sync", source: "openai", lastSuccessDay: "2026-10-17" },
      ],
    });
    expect(r.blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "🗓 Weekly updates · 12–18 Oct 2026", emoji: true } });
    expect(text(r)).toContain("⬜ *Claude Team spend* — pasted as of 11 Oct. Paste this morning's table (dated 18 Oct).");
    expect(text(r)).toContain("⬜ *ChatGPT credits* — imported through 11 Oct. Import a file through 18 Oct.");
    expect(text(r)).toContain("⬜ *OpenAI API* hasn't synced since the week ended (last 17 Oct). Re-run it on Data → Sync.");
    expect(text(r)).toContain("24 weekly summaries go out automatically once everything's in.");
    expect(r.blocks.at(-1)).toEqual({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open Data → Imports" }, url: "https://x.test/data?tab=imports" }] });
    expect(r.text).toBe("Weekly updates for 12–18 Oct 2026: 3 to do");
  });

  it("says everything's in when nothing is outstanding", () => {
    const r = weeklyReminder({ ...base, outstanding: [] });
    expect(text(r)).toContain("✅ Everything's in for 12–18 Oct 2026. Weekly summaries go out from 10:30.");
    expect(text(r)).not.toContain("go out automatically once");
    expect(r.text).toBe("Weekly updates for 12–18 Oct 2026: all done");
  });

  it("adds last month's missing imports while its recap waits", () => {
    const r = weeklyReminder({ ...base, outstanding: [], monthly: { monthName: "October", missing: ["Claude Team seats"] } });
    expect(text(r)).toContain("October's monthly recap is waiting too: ⬜ Claude Team seats");
  });

  it("one summary reads in the singular", () => {
    expect(text(weeklyReminder({ ...base, waiting: 1, outstanding: [{ kind: "claudeSpend", asOf: "2026-10-11" }] }))).toContain("1 weekly summary goes out automatically");
  });
});

describe("monthEndReminder", () => {
  it("asks for today's Claude Team paste before the table resets", () => {
    const r = monthEndReminder({ monthName: "October", importsUrl: "https://x.test/data?tab=imports" });
    expect(text(r)).toContain("Claude's table resets when the month ends. Pasting it today (dated today) captures October's last days for the monthly recap and the weekly summaries.");
    expect(r.text).toBe("Paste Claude Team spend today");
  });
});
```

- [ ] **Step 4: Implement reminders.ts**

```ts
import { VENDOR_LABEL } from "@/lib/types";
import type { Outstanding } from "./readiness";
import type { RenderedDigest, SlackBlock } from "./render";

/** The update reminders (spec §4). Pure: blocks + notification text. */
export interface WeeklyReminderInput {
  week: { label: string; lastDay: string }; // "12–18 Oct 2026", its Sunday
  outstanding: Outstanding[];
  /** Last month's recap is due but waiting: its missing imports' labels. */
  monthly: { monthName: string; missing: string[] } | null;
  waiting: number; // weekly recipients not sent yet
  importsUrl: string;
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const d = (day: string) => `${Number(day.slice(8, 10))} ${SHORT[Number(day.slice(5, 7)) - 1]}`;
const header = (text: string): SlackBlock => ({ type: "header", text: { type: "plain_text", text, emoji: true } });
const section = (text: string): SlackBlock => ({ type: "section", text: { type: "mrkdwn", text } });
const button = (url: string): SlackBlock => ({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open Data → Imports" }, url }] });

function line(o: Outstanding, lastDay: string): string {
  if (o.kind === "claudeSpend") return `⬜ *Claude Team spend* — pasted as of ${d(o.asOf)}. Paste this morning's table (dated ${d(lastDay)}).`;
  if (o.kind === "chatgptCredits") return `⬜ *ChatGPT credits* — imported through ${d(o.through)}. Import a file through ${d(lastDay)}.`;
  return `⬜ *${VENDOR_LABEL[o.source]}* hasn't synced since the week ended${o.lastSuccessDay ? ` (last ${d(o.lastSuccessDay)})` : ""}. Re-run it on Data → Sync.`;
}

export function weeklyReminder(i: WeeklyReminderInput): RenderedDigest {
  const lines = i.outstanding.length
    ? i.outstanding.map((o) => line(o, i.week.lastDay))
    : [`✅ Everything's in for ${i.week.label}. Weekly summaries go out from 10:30.`];
  if (i.monthly) lines.push(`${i.monthly.monthName}'s monthly recap is waiting too: ${i.monthly.missing.map((m) => `⬜ ${m}`).join(" · ")}`);
  const blocks: SlackBlock[] = [header(`🗓 Weekly updates · ${i.week.label}`), section(lines.join("\n"))];
  if (i.outstanding.length && i.waiting > 0) {
    const n = i.waiting === 1 ? "1 weekly summary goes" : `${i.waiting} weekly summaries go`;
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${n} out automatically once everything's in.` }] });
  }
  blocks.push(button(i.importsUrl));
  return { blocks, text: `Weekly updates for ${i.week.label}: ${i.outstanding.length ? `${i.outstanding.length} to do` : "all done"}` };
}

export function monthEndReminder(i: { monthName: string; importsUrl: string }): RenderedDigest {
  return {
    blocks: [
      header("🗓 Paste Claude Team spend today"),
      section(`Claude's table resets when the month ends. Pasting it today (dated today) captures ${i.monthName}'s last days for the monthly recap and the weekly summaries.`),
      button(i.importsUrl),
    ],
    text: "Paste Claude Team spend today",
  };
}
```

Run: `npx vitest run src/lib/notify/reminders.test.ts` → PASS.

- [ ] **Step 5: Send-log kind and store**

- `types.ts`: add `/** A send-log row's message: a digest, or an update reminder. */ export type SendReport = ReportKind | "reminder";`
- `store.ts`: `SendKey.report: SendReport`; `sendStates` row type uses `report: SendReport`; `everLive` query adds `.in("report", ["personal", "company"])` (and its doc: "Reminders don't count"); new method on the interface and implementation:

```ts
  /** notification_reminder_recipients: who gets the update reminders. */
  reminderRecipients(): Promise<string[]>;
```

```ts
    async reminderRecipients() {
      const rows = await pageAll<{ employee_id: string }>(
        (a, b) => supabase.from("notification_reminder_recipients").select("employee_id").order("employee_id").range(a, b),
        "notification_reminder_recipients",
      );
      return rows.map((r) => r.employee_id);
    },
```

- `memory-store.ts`: seed `reminderRecipients?: string[]`; `reminderRecipients: async () => seed.reminderRecipients ?? []`; `everLive` filter adds `s.report !== "reminder"`; `SeedSendRow`'s `report?: SendReport`.
- `run-notify.ts` `who`: ``const who = (k: SendKey) => `employee=${k.employeeId} cadence=${k.cadence}${k.report !== "personal" ? ` report=${k.report}` : ""}`;``
- Fix any compile error `npx tsc --noEmit` names where a `ReportKind` was expected from a `SendKey` (e.g. `markOpened`'s return keeps `send.report as ReportKind`; reminders have no open link).

- [ ] **Step 6: Run-reminders tests**

`src/lib/notify/run-reminders.test.ts` (copy `emp`, `fakeSlack`, `png` helpers from `run-notify.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { memoryStore, type MemorySeed } from "./memory-store";
import type { RunNotifyDeps } from "./run-notify";
import { runReminders } from "./run-reminders";
import type { SlackClient } from "./slack-client";
import type { NotifyEmployee } from "./types";

const MON = new Date("2026-10-19T08:30:00Z"); // 09:30 BST Monday
const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: `Person ${id}`, department: "Eng", oktaId: `00u${id}`, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
function fakeSlack(tz = "Europe/London") {
  const posts: { channel: string; blocks: unknown[]; text: string }[] = [];
  const client: SlackClient = {
    lookupUserByEmail: async (email) => ({ id: `U-${email.split("@")[0]}`, tz }),
    openDm: async (u) => `D-${u}`,
    uploadImage: async () => "F1",
    postMessage: async (channel, blocks, text) => { posts.push({ channel, blocks, text }); return `ts${posts.length}`; },
  };
  return { client, posts };
}
const seed = (over: MemorySeed = {}): MemorySeed => ({
  employees: [emp("g"), emp("m")],
  reminderRecipients: ["g"],
  subscriptions: [{ employeeId: "m", cadence: "weekly" }],
  syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-10-19T06:00:03Z" }],
  manualImports: [{ source: "claude_team", kind: "clipboard", dataAsOf: "2026-10-11" }],
  ...over,
});
const deps = (store: ReturnType<typeof memoryStore>, slack: SlackClient, over: Partial<RunNotifyDeps> = {}): RunNotifyDeps => ({
  store, slack, renderChart: async () => new Uint8Array([1]) as Uint8Array<ArrayBuffer>, mode: "live", previewEmail: "g@x.com", now: MON,
  baseUrl: "https://x.test", adminEmails: [], clock: () => MON.getTime(), log: () => {}, sleep: async () => {}, ...over,
});

describe("runReminders", () => {
  it("DMs the Monday reminder once, listing what's outstanding and who's waiting", async () => {
    const store = memoryStore(seed(), () => MON.getTime());
    const slack = fakeSlack();
    expect(await runReminders(deps(store, slack.client))).toMatchObject({ due: ["weekly:2026-W42"], sent: 1 });
    expect(slack.posts[0].channel).toBe("D-U-g");
    expect(JSON.stringify(slack.posts[0].blocks)).toContain("Claude Team spend* — pasted as of 11 Oct");
    expect(JSON.stringify(slack.posts[0].blocks)).toContain("1 weekly summary goes out automatically");
    expect(store.sends[0]).toMatchObject({ employeeId: "g", cadence: "weekly", periodKey: "2026-W42", report: "reminder", status: "sent" });
    expect(await runReminders(deps(store, slack.client))).toMatchObject({ sent: 0, alreadyHandled: 1 });
    expect(slack.posts).toHaveLength(1);
  });

  it("waits until 09:30 local and sends nothing on a Tuesday", async () => {
    const early = new Date("2026-10-19T08:29:00Z");
    expect(await runReminders(deps(memoryStore(seed()), fakeSlack().client, { now: early, clock: () => early.getTime() }))).toMatchObject({ sent: 0, waiting: 1 });
    const tue = new Date("2026-10-20T08:30:00Z");
    expect(await runReminders(deps(memoryStore(seed()), fakeSlack().client, { now: tue, clock: () => tue.getTime() }))).toMatchObject({ sent: 0, due: [] });
  });

  it("sends the month-end Claude Team reminder on the last working day", async () => {
    const fri = new Date("2026-10-30T15:00:00Z");
    const slack = fakeSlack();
    expect(await runReminders(deps(memoryStore(seed()), slack.client, { now: fri, clock: () => fri.getTime() }))).toMatchObject({ due: ["monthEnd:2026-10"], sent: 1 });
    expect(slack.posts[0].text).toBe("Paste Claude Team spend today");
  });

  it("a reminder doesn't use up someone's first-message intro", async () => {
    const store = memoryStore(seed(), () => MON.getTime());
    await runReminders(deps(store, fakeSlack().client));
    expect(await store.everLive(["g"])).toEqual(new Set());
  });

  it("in preview mode goes to the previewer, marked as a preview", async () => {
    const store = memoryStore(seed({ employees: [emp("g"), emp("m"), emp("p")], reminderRecipients: ["g"] }), () => MON.getTime());
    const slack = fakeSlack();
    await runReminders(deps(store, slack.client, { mode: "preview", previewEmail: "p@x.com" }));
    expect(slack.posts[0].channel).toBe("D-U-p");
    expect(slack.posts[0].text.startsWith("[Preview for Person g] ")).toBe(true);
  });

  it("does nothing without recipients", async () => {
    expect(await runReminders(deps(memoryStore(seed({ reminderRecipients: [] })), fakeSlack().client))).toMatchObject({ due: [], sent: 0 });
  });
});
```

- [ ] **Step 7: Implement run-reminders.ts**

```ts
import { monthlyReadiness } from "./freshness";
import { deliverRendered, PostOutcomeUnknownError, resolveSlackUser, type SlackRecipient } from "./deliver";
import { importsInUseSince, readinessSyncSince, weekReadiness } from "./readiness";
import { monthEndReminder, weeklyReminder } from "./reminders";
import type { RenderedDigest } from "./render";
import { claim, errorDetail, type RunNotifyDeps } from "./run-notify";
import { dueReminders, inMonthlyWindow, latestCompleteKey, periodFor, type DueReminder } from "./schedule";
import type { SendKey } from "./store";
import { isActiveEmployee, type NotifyEmployee } from "./types";

export interface RunRemindersResult {
  due: string[];
  sent: number;
  failed: number;
  alreadyHandled: number;
  waiting: number; // recipients before their reminder time
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Update reminders (spec §4): Monday 09:30 "weekly updates" and the month's last working day 15:00
 * "paste Claude Team", in each recipient's time zone. Claimed in notification_sends (report
 * "reminder") — never twice. Runs before runNotify in the cron; cheap: nothing is loaded unless one is due.
 */
export async function runReminders(deps: RunNotifyDeps): Promise<RunRemindersResult> {
  const { store, slack, now } = deps;
  const log = deps.log ?? console.log;
  const result: RunRemindersResult = { due: [], sent: 0, failed: 0, alreadyHandled: 0, waiting: 0 };
  const ids = await store.reminderRecipients();
  if (!ids.length) return result;
  const employees = await store.employees();
  const byId = new Map(employees.map((e) => [e.id, e]));
  const previewTarget = deps.mode === "preview" ? employees.find((e) => e.email === deps.previewEmail?.trim().toLowerCase()) : undefined;
  if (deps.mode === "preview" && !previewTarget) throw new Error("SLACK_PREVIEW_EMAIL does not match an employee");

  const work: { recipient: NotifyEmployee; slackUser: SlackRecipient; reminder: DueReminder }[] = [];
  for (const id of ids) {
    const recipient = byId.get(id);
    if (!recipient || !isActiveEmployee(recipient)) continue;
    const target = previewTarget ?? recipient;
    let slackUser: SlackRecipient | null;
    try {
      slackUser = await resolveSlackUser(store, slack, target, now);
    } catch (err) {
      result.failed++;
      log(`[notify] reminder Slack lookup failed employee=${target.id}: ${errorDetail(err)}`);
      continue;
    }
    if (!slackUser) continue;
    const due = dueReminders(now, slackUser.tz, { anyTime: deps.replay });
    if (!due.length) {
      result.waiting++;
      continue;
    }
    for (const reminder of due) work.push({ recipient, slackUser, reminder });
  }
  result.due = [...new Set(work.map((w) => `${w.reminder.kind}:${w.reminder.periodKey}`))];
  if (!work.length) return result;

  const states = await store.sendStates([...new Set(work.map((w) => w.reminder.periodKey))], deps.mode);
  const handled = (w: (typeof work)[number]) =>
    states.some((s) => s.report === "reminder" && s.employeeId === w.recipient.id && s.cadence === w.reminder.cadence && s.periodKey === w.reminder.periodKey);
  const open = work.filter((w) => {
    if (!handled(w)) return true;
    result.alreadyHandled++;
    return false;
  });
  if (!open.length) return result;

  const importsUrl = `${deps.baseUrl}/data?tab=imports`;
  const weekly = open.find((w) => w.reminder.kind === "weekly");
  let weeklyMessage: RenderedDigest | null = null;
  if (weekly) {
    const at = new Date(`${weekly.reminder.day}T12:00:00Z`);
    const week = periodFor("weekly", weekly.reminder.periodKey, at);
    const lastDay = new Date(Date.parse(`${week.toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const [syncRuns, imports, personal, company, sent] = await Promise.all([
      store.recentSyncRuns(readinessSyncSince(now)),
      store.manualImports(importsInUseSince(lastDay)),
      store.subscriptions(["weekly"]),
      store.companyRecipients(["weekly"]),
      store.sendStates([week.key], deps.mode),
    ]);
    const done = new Set(sent.filter((s) => s.report !== "reminder" && (s.status === "sent" || s.status === "pending")).map((s) => `${s.employeeId}|${s.report}`));
    const waiting = [...personal.map((s) => ({ ...s, report: "personal" })), ...company.map((s) => ({ ...s, report: "company" }))].filter((s) => {
      const e = byId.get(s.employeeId);
      return e && isActiveEmployee(e) && !done.has(`${s.employeeId}|${s.report}`);
    }).length;
    let monthly: { monthName: string; missing: string[] } | null = null;
    if (inMonthlyWindow(weekly.reminder.day)) {
      const prevMonth = latestCompleteKey("monthly", at);
      const m = monthlyReadiness(await store.importCoverage(weekly.reminder.day.slice(0, 7)), prevMonth);
      if (!m.ready) monthly = { monthName: MONTHS[Number(prevMonth.slice(5, 7)) - 1], missing: m.missing.map((x) => x.label) };
    }
    weeklyMessage = weeklyReminder({ week: { label: week.label, lastDay }, outstanding: weekReadiness({ week, syncRuns, imports }).outstanding, monthly, waiting, importsUrl });
  }

  for (const w of open) {
    const base = w.reminder.kind === "weekly" ? weeklyMessage! : monthEndReminder({ monthName: MONTHS[Number(w.reminder.periodKey.slice(5, 7)) - 1], importsUrl });
    const message: RenderedDigest = previewTarget
      ? { blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: `Preview for *${w.recipient.fullName}* (update reminder)` }] }, ...base.blocks], text: `[Preview for ${w.recipient.fullName}] ${base.text}` }
      : base;
    const key: SendKey = { employeeId: w.recipient.id, cadence: w.reminder.cadence, periodKey: w.reminder.periodKey, mode: deps.mode, report: "reminder" };
    if (!(await claim(store, key, result, log))) continue;
    let posted = false;
    try {
      const ts = await deliverRendered({ slack, renderChart: deps.renderChart, slackUserId: w.slackUser.slackUserId, layouts: {}, render: () => message, log, sleep: deps.sleep });
      posted = true;
      await store.finishSend(key, { status: "sent", slackTs: ts });
      result.sent++;
    } catch (err) {
      if (posted) {
        result.sent++;
        log(`[notify] reminder sent but not recorded employee=${key.employeeId}: ${errorDetail(err)}`);
      } else if (err instanceof PostOutcomeUnknownError) {
        result.failed++; // leave pending → expires "interrupted", never retried
        log(`[notify] reminder post outcome unknown employee=${key.employeeId}: ${err.code}`);
      } else {
        result.failed++;
        log(`[notify] reminder failed employee=${key.employeeId}: ${errorDetail(err)}`);
        await store.finishSend(key, { status: "failed", detail: errorDetail(err) }).catch(() => undefined);
      }
    }
  }
  return result;
}
```

(The preview lookup above resolves the *previewer's* Slack account and time zone, as runNotify does.)

- [ ] **Step 8: Cron route**

`src/app/api/cron/notify/route.ts`: build the deps object once, run reminders first, then digests:

```ts
    const deps = {
      store: supabaseNotifyStore(getSupabaseAdminClient()),
      slack: slackClientFromEnv(),
      renderChart: renderChartPng,
      renderBanner: renderWelcomeBannerPng,
      mode,
      previewEmail: process.env.SLACK_PREVIEW_EMAIL ?? null,
      now: runDate.now,
      replay: runDate.replay,
      baseUrl: appBaseUrl(),
      adminEmails: parseAdminEmails(process.env.ADMIN_EMAILS),
    };
    // Reminders first: tiny, and their 09:30 slot is before the digests' 10:30.
    const reminders = await runReminders(deps);
    const result = await runNotify(deps);
    return NextResponse.json({ ranAt: new Date().toISOString(), mode, ...result, reminders });
```

with `import { runReminders } from "@/lib/notify/run-reminders";`. Update the route's doc comment: "…then update reminders (runReminders) at Monday 09:30 / the month's last working day 15:00".

- [ ] **Step 9: Run tests and types**

Run: `npm run test` and `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/lib/notify src/app/api/cron/notify/route.ts
git commit -m "feat(notify): Monday update reminders and the month-end Claude Team reminder

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Admin views — reminder list, weekly status, Imports wording

**Files:**
- Create: `src/lib/notify/week-status.ts`, `src/lib/notify/week-status.test.ts`, `src/components/notifications/reminder-recipients.tsx`
- Modify: `src/lib/notify/admin-store.ts`, `src/app/(dashboard)/data/notifications-actions.ts`, `src/app/(dashboard)/data/notifications-tab.tsx`, `src/lib/imports/checklist.ts`, `src/lib/imports/checklist.test.ts`

**Interfaces:**
- Consumes: Task 5 (`weekReadiness`, `outstandingShort`, `readinessSyncSince`, `importsInUseSince`), `periodFor`, `latestCompleteKey`.
- Produces:
  - `weekStatus(i: { label: string; readiness: Readiness; recipients: number; sent: number; today: string; weekToExclusive: string }): { title: string; text: string; state: "waiting" | "ready" | "sent" | "skipped" }`
  - `admin-store.ts`: `ReminderRecipientRow { employeeId; name; team; slack; left }`, `NotificationsAdminData.reminderRecipients`, `.reminderPeople`, `.weekStatus`; `addReminderRecipients(supabase, ids, createdBy)`, `removeReminderRecipient(supabase, id)`
  - actions `addReminderRecipient(employeeId: string)`, `removeReminderRecipientAction(employeeId: string)`

- [ ] **Step 1: Status tests**

```ts
import { describe, expect, it } from "vitest";
import { weekStatus } from "./week-status";

const base = { label: "12–18 Oct 2026", weekToExclusive: "2026-10-19", recipients: 24, sent: 0 };
describe("weekStatus", () => {
  it("waiting: names what's missing", () => {
    expect(weekStatus({ ...base, today: "2026-10-19", readiness: { ready: false, outstanding: [{ kind: "claudeSpend", asOf: "2026-10-11" }, { kind: "chatgptCredits", through: "2026-10-11" }] } }))
      .toEqual({ state: "waiting", title: "Weekly 12–18 Oct 2026", text: "Waiting for Claude Team (pasted as of 11 Oct) · ChatGPT credits (through 11 Oct)" });
  });
  it("ready, not sent yet", () => {
    expect(weekStatus({ ...base, today: "2026-10-19", readiness: { ready: true, outstanding: [] } }).text).toBe("Ready — going out from 10:30");
  });
  it("sent", () => {
    expect(weekStatus({ ...base, sent: 24, today: "2026-10-20", readiness: { ready: true, outstanding: [] } })).toMatchObject({ state: "sent", text: "Sent to 24 of 24" });
  });
  it("skipped once Friday has passed without it", () => {
    expect(weekStatus({ ...base, today: "2026-10-24", readiness: { ready: false, outstanding: [{ kind: "claudeSpend", asOf: "2026-10-11" }] } }))
      .toMatchObject({ state: "skipped", text: "Skipped — not ready by Friday" });
  });
});
```

- [ ] **Step 2: Implement week-status.ts**

```ts
import { outstandingShort, type Readiness } from "./readiness";

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Data → Notifications' line for the latest complete week (spec §5). Pure. */
export function weekStatus(i: { label: string; readiness: Readiness; recipients: number; sent: number; today: string; weekToExclusive: string }) {
  const title = `Weekly ${i.label}`;
  if (i.sent > 0) return { state: "sent" as const, title, text: `Sent to ${i.sent} of ${i.recipients}` };
  const friday = addDays(i.weekToExclusive, 4); // the Friday after the week
  if (i.today > friday) return { state: "skipped" as const, title, text: "Skipped — not ready by Friday" };
  if (i.readiness.ready) return { state: "ready" as const, title, text: "Ready — going out from 10:30" };
  return { state: "waiting" as const, title, text: `Waiting for ${i.readiness.outstanding.map(outstandingShort).join(" · ")}` };
}
```

Run: `npx vitest run src/lib/notify/week-status.test.ts` → PASS.

- [ ] **Step 3: admin-store — list, people and status**

In `loadNotificationsAdmin` add to the `Promise.all`:

```ts
    pageAll<{ employee_id: string }>(
      (a, b) => supabase.from("notification_reminder_recipients").select("employee_id").order("employee_id").range(a, b),
      "notification_reminder_recipients",
    ),
    loadWeekStatus(supabase, new Date()),
```

and build

```ts
  const reminderSet = new Set(reminderRows.map((r) => r.employee_id));
  const reminderRecipients: ReminderRecipientRow[] = [...reminderSet].map((id) => {
    const e = byId.get(id);
    return { employeeId: id, name: e?.fullName ?? "Unknown", team: e?.department ?? null, slack: slackStatus(id), left: e ? !isActiveEmployee(e) : true };
  }).sort((a, b) => a.name.localeCompare(b.name));
```

returning `reminderRecipients`, `reminderPeople: activePeople.filter((p) => !reminderSet.has(p.id))`, `weekStatus`. Add the types:

```ts
export interface ReminderRecipientRow { employeeId: string; name: string; team: string | null; slack: RecipientRow["slack"]; left: boolean }
// NotificationsAdminData gains:
  reminderRecipients: ReminderRecipientRow[];
  reminderPeople: PersonOption[];
  weekStatus: ReturnType<typeof weekStatus>;
```

`loadWeekStatus`:

```ts
async function loadWeekStatus(supabase: SupabaseClient, now: Date) {
  const store = supabaseNotifyStore(supabase);
  const today = now.toISOString().slice(0, 10);
  const week = periodFor("weekly", latestCompleteKey("weekly", now), now);
  const lastDay = new Date(Date.parse(`${week.toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const mode = notifyMode() === "preview" ? "preview" : "live";
  const [syncRuns, imports, personal, company, states] = await Promise.all([
    store.recentSyncRuns(readinessSyncSince(now)),
    store.manualImports(importsInUseSince(lastDay)),
    store.subscriptions(["weekly"]),
    store.companyRecipients(["weekly"]),
    store.sendStates([week.key], mode),
  ]);
  return weekStatus({
    label: week.label,
    readiness: weekReadiness({ week, syncRuns, imports }),
    recipients: personal.length + company.length,
    sent: states.filter((s) => s.report !== "reminder" && s.status === "sent").length,
    today,
    weekToExclusive: week.toExclusive,
  });
}
```

Recipient helpers (beside `addSubscriptions`):

```ts
export async function addReminderRecipients(supabase: SupabaseClient, employeeIds: string[], createdBy: string): Promise<number> {
  const { data, error } = await supabase
    .from("notification_reminder_recipients")
    .upsert(employeeIds.map((employee_id) => ({ employee_id, created_by: createdBy })), { onConflict: "employee_id", ignoreDuplicates: true })
    .select("employee_id");
  if (error) throw new Error(`addReminderRecipients: ${error.message}`);
  return data?.length ?? 0;
}

export async function removeReminderRecipient(supabase: SupabaseClient, employeeId: string): Promise<void> {
  const { error } = await supabase.from("notification_reminder_recipients").delete().eq("employee_id", employeeId);
  if (error) throw new Error(`removeReminderRecipient: ${error.message}`);
}
```

- [ ] **Step 4: Actions**

`notifications-actions.ts`:

```ts
/** Adds someone to the update reminders (Monday 09:30 and the month's last working day). */
export async function addReminderRecipient(employeeId: string): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId)) throw new Error("Invalid input");
  await addReminderRecipients(getSupabaseAdminClient(), [employeeId], await actorEmail());
  revalidatePath("/data");
}

export async function removeReminderRecipientAction(employeeId: string): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId)) throw new Error("Invalid input");
  await removeReminderRecipient(getSupabaseAdminClient(), employeeId);
  revalidatePath("/data");
}
```

- [ ] **Step 5: Component**

`src/components/notifications/reminder-recipients.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { addReminderRecipient, removeReminderRecipientAction } from "@/app/(dashboard)/data/notifications-actions";
import type { PersonOption, ReminderRecipientRow } from "@/lib/notify/admin-store";
import { SLACK_STATUS } from "./recipients-table";

/** Who gets the update reminders. */
export function ReminderRecipients({ rows, people }: { rows: ReminderRecipientRow[]; people: PersonOption[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const idByLabel = new Map(people.map((p) => [p.label, p.id]));
  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  return (
    <div className="space-y-3">
      {error && <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <datalist id="notify-reminder-people">{people.map((p) => <option key={p.id} value={p.label} />)}</datalist>
        <input list="notify-reminder-people" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Add a person…" aria-label="Add an update-reminder recipient"
          className="w-56 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        <button disabled={pending || !idByLabel.has(person)} onClick={() => run(async () => { await addReminderRecipient(idByLabel.get(person)!); setPerson(""); })}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40">Add</button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody gets the reminders yet.</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border text-sm">
          {rows.map((r) => (
            <li key={r.employeeId} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>
                <span className="font-medium">{r.name}</span>
                {r.left && <span className="ml-2 rounded bg-pink-500/15 px-1.5 text-[10px] text-pink-300">left</span>}
                <span className={`ml-2 text-xs ${SLACK_STATUS[r.slack].cls}`}>{SLACK_STATUS[r.slack].text}</span>
              </span>
              <button disabled={pending} onClick={() => run(() => removeReminderRecipientAction(r.employeeId))} className="text-xs text-muted hover:text-pink-300">Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Notifications tab**

In `notifications-tab.tsx`: the top grid becomes `md:grid-cols-2 xl:grid-cols-4` with a new first panel

```tsx
        <Panel>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">{data.weekStatus.title}</p>
          <p className={`my-1 text-sm font-semibold ${data.weekStatus.state === "waiting" || data.weekStatus.state === "skipped" ? "text-amber-300" : ""}`}>
            {data.weekStatus.state === "sent" ? "Sent" : data.weekStatus.state === "ready" ? "Ready" : data.weekStatus.state === "skipped" ? "Skipped" : "Waiting"}
          </p>
          <p className="text-xs text-muted">{data.weekStatus.text}</p>
        </Panel>
```

and after the Company report section, inside the same Panel:

```tsx
          <div className="mt-6 border-t border-border pt-4">
            <h2 className="mb-1 text-sm font-medium">Update reminders · {data.reminderRecipients.length}</h2>
            <p className="mb-3 text-xs text-muted">
              A Slack message on Mondays at 09:30 listing what&apos;s left before the weekly summaries can go (Claude Team paste, ChatGPT credits, failed syncs),
              and on the month&apos;s last working day at 15:00 a reminder to paste Claude Team spend before its table resets.
            </p>
            <ReminderRecipients rows={data.reminderRecipients} people={data.reminderPeople} />
          </div>
```

with `import { ReminderRecipients } from "@/components/notifications/reminder-recipients";`.

- [ ] **Step 7: Imports checklist — weekly Claude paste wording (test first)**

`checklist.test.ts`: the base case (today Fri 16 Oct, pasted as of 12 Oct ≥ Sunday 11 Oct) becomes

```ts
    expect(item(importChecklist(base), "claudeSpend")).toMatchObject({ done: true, status: "Pasted as of 12 Oct", detail: "October so far $17,829" });
```

and add

```ts
  it("Claude spend is due each week: pasted as of last Sunday", () => {
    const late = { ...base, today: "2026-10-20" }; // Tue: last Sunday is 18 Oct
    expect(item(importChecklist(late), "claudeSpend")).toMatchObject({ done: false, status: "Pasted as of 12 Oct · due as of 18 Oct", action: "Paste the spend table" });
    const none = { ...base, imports: base.imports.filter((i) => i.source !== "claude_team" || !i.dataAsOf.startsWith("2026-10")) };
    expect(item(importChecklist(none), "claudeSpend")).toMatchObject({ done: false, status: "Due: paste as of 11 Oct" });
  });

  it("early in a month before its first Sunday, nothing is due yet", () => {
    const dec = { coverage: [], imports: [], seatEntries: [], today: "2026-12-01" }; // Tue; last Sunday 29 Nov
    expect(item(importChecklist(dec), "claudeSpend")).toMatchObject({ done: true, status: "First paste due Monday" });
  });
```

In `checklist.ts` `tasksFor`, replace the `spend` item with:

```ts
  const spendAsOf = latest(input.imports.filter((r) => ok(r) && r.source === "claude_team" && r.kind === "clipboard" && r.dataAsOf.startsWith(month)).map((r) => r.dataAsOf));
  // This month: due weekly — pasted as of the Sunday just gone (readiness.ts). An earlier month: one paste.
  const dueAsOf = current ? lastSunday(input.today) : null;
  const spendDone = current ? (dueAsOf! < `${month}-01` ? true : !!spendAsOf && spendAsOf >= dueAsOf!) : !!spendAsOf;
  const spendStatus = !current
    ? (spendAsOf ? `As of ${shortDay(spendAsOf)}` : "Not pasted")
    : dueAsOf! < `${month}-01`
      ? (spendAsOf ? `Pasted as of ${shortDay(spendAsOf)}` : "First paste due Monday")
      : spendDone
        ? `Pasted as of ${shortDay(spendAsOf!)}`
        : spendAsOf ? `Pasted as of ${shortDay(spendAsOf)} · due as of ${shortDay(dueAsOf!)}` : `Due: paste as of ${shortDay(dueAsOf!)}`;
  const spend: ChecklistItem = {
    key: "claudeSpend", vendor: "claude_team", label: "Claude spend", done: spendDone,
    status: spendStatus,
    detail: `${name} so far ${usd(row?.claudeSpend)}`,
    action: spendDone ? "Paste a newer table" : "Paste the spend table",
    anchor: "claude-spend",
  };
```

with the helper near the top of the file:

```ts
/** The Sunday before `today` (YYYY-MM-DD); on a Monday, yesterday. */
export function lastSunday(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  return new Date(Date.parse(`${today}T00:00:00Z`) - (dow === 0 ? 7 : dow) * 86_400_000).toISOString().slice(0, 10);
}
```

(`"First paste due Monday"` with `done: true` and no paste: when `dueAsOf < month start` the status is that line only if there's no paste; with a paste it's "Pasted as of …".)

- [ ] **Step 8: Run tests, types, lint**

Run: `npm run test`, `npx tsc --noEmit`, `npm run lint`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/lib/notify/week-status.ts src/lib/notify/week-status.test.ts src/lib/notify/admin-store.ts src/components/notifications/reminder-recipients.tsx src/app/\(dashboard\)/data/notifications-actions.ts src/app/\(dashboard\)/data/notifications-tab.tsx src/lib/imports/checklist.ts src/lib/imports/checklist.test.ts
git commit -m "feat(notifications): update-reminder list, this week's status, weekly Claude paste on Imports

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Docs, changelog, full verification

**Files:**
- Modify: `CLAUDE.md`, `src/lib/changelog.ts`

- [ ] **Step 1: CLAUDE.md**

- *ChatGPT Business / Claude Team (manual imports)* bullet: replace "Each import is a monthly snapshot-replace stamped to the 'Month' field's calendar month." for Claude Team with: "**Claude Team spend is pasted every Monday (dated Sunday — the form's default) and on the month's last working day** (its table resets at month end). Every paste is kept (`claude_spend_snapshots`, migration 0024, applied before deploy) and the month's facts are rebuilt as **daily** facts: each person's increase since their previous paste spread evenly over the days in between (`ingest/claude-spread.ts`, `run-claude-spend.ts`); the month still totals the latest paste. Rebuilt on each paste, nightly for this and last month (`runAllSyncs` job `claude_spend`), and on demand (Data → Sync). Daily summaries leave it out (`shape.ts:SPREAD_SOURCES`). There is no month-lump/as-of machinery any more (`MONTHLY_SNAPSHOT_SOURCES`/`snapshotAsOf` were retired; `isMonthlyLevelFact` = seats & subscriptions)."
- *Slack digests* bullet: replace the 10:30/monthly-window sentences with: "**Weeklies and monthlies go only when complete** (`readiness.ts:weekReadiness` — every automatic source in use synced since the week ended, ChatGPT credits imported through Sunday, Claude Team pasted as of Sunday; imports only if used in the last two months): a weekly is due any working day once its week is ready and is **skipped if not ready by Friday**; a monthly is due from the 3rd to month end once ready and is **never forced**. The daily alone waits for the day's sync. **Update reminders** (`run-reminders.ts`, run first by the cron; recipients `notification_reminder_recipients`, Data → Notifications): Monday 09:30 local lists what's outstanding; the month's last working day 15:00 asks for the Claude Team paste. Claimed in `notification_sends` with `report = 'reminder'` (never twice; `everLive` ignores them)."
- Data model: under `cost_type`, note Claude Team usage is daily-spread overage.

- [ ] **Step 2: Changelog** — a new entry at the top of `CHANGELOG`. `date` is the entry's identity: use the day this ships; if an entry already has that date, append these items to it instead.

```ts
  {
    date: "2026-10-21",
    title: "Weekly summaries wait for complete figures",
    items: [
      "Weekly Slack summaries now wait until the week's figures are complete — including Claude Team spend, which now counts in weekly summaries — and monthly recaps wait for their imports instead of going out with warnings.",
      "Admins can get a Monday Slack reminder of what's left to update, and a month-end reminder to paste Claude Team spend. Add people on Data → Notifications.",
      "Claude Team spend now shows on the days it was used in Explore, instead of all on the 1st.",
    ],
  },
```

- [ ] **Step 3: Full verification**

Run: `npm run test` → all pass; `npm run lint` → clean; `CI=true npm run build` → compiles.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md src/lib/changelog.ts
git commit -m "docs: weekly readiness, Claude Team daily spread, update reminders

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand back** — report to the user: migration 0024 to apply before deploy; after deploy click Data → Sync "Rebuild Claude Team spend" (before the next Monday) and add themselves on Data → Notifications → Update reminders. Do not push or deploy.
