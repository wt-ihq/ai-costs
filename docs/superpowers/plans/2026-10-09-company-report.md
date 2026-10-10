# Company AI Spend Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A whole-company AI spend report sent as its own Slack DM to admin-chosen recipients on their chosen cadences.

**Architecture:**
- **Digest:** a new digest kind, `CompanyDigest`, is built from the shared `NotifyContext`. It has a usage section, ranked by team and by person, and a text-only seats & subscriptions section.
- **Recipients:** a new table, `notification_company_recipients`.
- **Send log:** `notification_sends` gains a `report` column that is part of the claim key.
- **Cron:** the existing hourly cron sends both kinds through the same claim → build → DM → mark loop. It builds the company digest once per period per run.
- **Admin:** previews, test sends and the Notifications tab gain a "company" subject.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase/PostgREST, Vitest, Slack Block Kit.

**Spec:** `docs/superpowers/specs/2026-10-09-company-report-design.md`

## Global Constraints

- **Branch and release.**
  - Work on branch `company-report` (already created off `main`; the spec is committed there).
  - Do not merge, push, deploy, or apply the migration to production without the user's explicit go-ahead.
- **Migration order.** `supabase/migrations/0019_company_report.sql` must be applied to production BEFORE the code is deployed.
- **Server actions.** Every new `"use server"` action starts with `await requireAdmin()`.
- **No cache work.**
  - No `spend_facts` writes, so no `FACTS_TAG` bust.
  - No `*Cached` reader shape change, so no `CACHE_VERSION` bump.
- **Escaping.**
  - Every user-supplied string (person names, department names) in mrkdwn goes through `escapeMrkdwn`.
  - Header blocks are `plain_text` and are not escaped.
  - Slack also parses the plain-text fallback `text` as mrkdwn, so escape `&` there too.
- **Send log safety.** `notification_sends` is claim-before-send. Never make a row retryable once a DM may have gone out.
- **Logs.** Logs carry ids only, never names or amounts.
- **Copy, verbatim:**
  - Header: `📊 Company AI spend · <period label>`.
  - Section labels: `COMPANY · N PEOPLE` and `SEATS & SUBSCRIPTIONS`.
  - Share wording: `a day's share of the monthly bill` / `a week's share of the monthly bill`.
  - Line items: `unattributed $X`, `not tied to a person $X`, `+N teams $X` (`+1 team $X`).
  - Monthly line: `<Month YYYY> total $X · usage + seats & subscriptions`.
  - Test banner: `🧪 Test: the company <cadence> report, sent to you by <admin>`.
- **Commit trailer.** Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Native tasks.** Do not use TaskCreate while building: a pre-commit hook blocks commits while native tasks are open.
- **Type-checking.**
  - `npx tsc --noEmit` type-checks tests too (tsconfig includes `**/*.ts`).
  - If it reports errors in `.next/types/validator.ts` about routes that don't exist on this branch, run `CI=true npm run build` once to regenerate them, then re-run tsc.

## Review Focus

These are the cases a user would hit first, each pinned by a test in the owning task:

1. **Someone on both lists for the same period** (manager `m`: personal weekly and company weekly). Expected: two DMs and two send rows, and neither counts as "already handled" for the other. Pinned in Task 4.
2. **A failed personal send with no attempts left, for the same person and period.** Expected: it must not block the company send, and the company claim must not take over the personal row. Pinned in Task 4.
3. **Department names with Slack control characters** (`R&D <Ops>`) in the top-teams line. Expected: the name is escaped in the text and URL-encoded in the link. Pinned in Task 3.
4. **The first month with fixed costs (no previous month).** Expected: the month line shows the figure alone, with no "Infinity%" or "-100%". Pinned in Tasks 2 and 3.
5. **A daily for a day with no usage** (a weekend-adjacent or quiet day). Expected: the bill alone never makes a DM. The cron logs the send as skipped / "no usage" (Task 4), and a test send says "Nothing to send for that period (no usage)" (Task 5).

---

### Task 1: Migration, report kind on the send log, company recipients in the store

**Files:**
- Create: `supabase/migrations/0019_company_report.sql`
- Modify: `src/lib/notify/types.ts` (append after `SendMode`)
- Modify: `src/lib/notify/store.ts` (`SendKey`, `NotifyStore`, `keyMatch`, `subscriptions`, `sendStates`, `markOpened`)
- Modify: `src/lib/notify/memory-store.ts`
- Modify: `src/lib/notify/opens.ts`
- Modify: `src/lib/notify/run-notify.ts` (`sendKey` and the already-handled match only: personal for now)
- Test: `src/lib/notify/opens.test.ts`

**Interfaces:**
- Produces:
  - `type ReportKind = "personal" | "company"` (types.ts).
  - `SendKey.report: ReportKind`.
  - `NotifyStore.companyRecipients(cadences: Cadence[]): Promise<{ employeeId: string; cadence: Cadence }[]>`.
  - `NotifyStore.sendStates` rows carry `report`.
  - `NotifyStore.markOpened` returns `{ employeeId; department; report } | null`.
  - `MemorySeed.companyRecipients?`, and `MemorySeed.sends` rows may omit `report` (default `"personal"`).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0019_company_report.sql`:

```sql
-- Company AI spend report (spec: docs/superpowers/specs/2026-10-09-company-report-design.md).
-- Who gets the whole-company report, on which cadences. Separate from notification_subscriptions,
-- so that table's key (and the running code's upsert on it) is untouched.
-- Apply BEFORE deploying: the cron reads this table and writes notification_sends.report on every run.
create table if not exists notification_company_recipients (
  employee_id uuid not null references employees(id) on delete cascade,
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (employee_id, cadence)
);
alter table notification_company_recipients enable row level security;

-- Which DM a send was. Existing rows, and the code running until the deploy, are personal.
alter table notification_sends
  add column if not exists report text not null default 'personal' check (report in ('personal', 'company'));
alter table notification_sends drop constraint if exists notification_sends_employee_id_cadence_period_key_mode_key;
alter table notification_sends
  add constraint notification_sends_employee_cadence_period_mode_report_key unique (employee_id, cadence, period_key, mode, report);
```

(The dropped constraint name was checked against production on 2026-10-09.)

- [ ] **Step 2: Write the failing test**

In `src/lib/notify/opens.test.ts`, add `report: "personal"` to the `row()` fixture (a `SendRow` now requires it):

```ts
const row = (over: Partial<SendRow> = {}): SendRow => ({
  id: ID, employeeId: emp.id, cadence: "weekly", periodKey: "2026-W41", mode: "live", report: "personal", status: "sent", attempts: 1,
  slackTs: "1", detail: null, updatedAt: "2026-10-12T09:30:00Z", openedAt: null, ...over,
});
```

Then add inside `describe("openRedirectPath", …)`:

```ts
  it("records a company report's open and lands on the Company page", async () => {
    const store = memoryStore({ employees: [emp], sends: [row({ report: "company" })] });
    expect(await openRedirectPath(store, ID)).toBe("/explore");
    expect(store.sends[0].openedAt).not.toBeNull();
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/notify/opens.test.ts`

Expected: FAIL. The new test receives `/explore/R%26D/<id>` instead of `/explore`.

- [ ] **Step 4: Add the report kind**

In `src/lib/notify/types.ts`, after `export type SendMode = …`:

```ts
/** Which DM a send is: the person's own digest, or the whole-company report. */
export type ReportKind = "personal" | "company";
```

- [ ] **Step 5: Carry `report` through the Supabase store**

In `src/lib/notify/store.ts`:

1. Import it:

```ts
import { NOTIFY_EMPLOYEE_COLUMNS, toNotifyEmployee, type Cadence, type NotifyEmployee, type ReportKind, type SendMode } from "./types";
```

2. Extend `SendKey`:

```ts
export interface SendKey {
  employeeId: string;
  cadence: Cadence;
  periodKey: string;
  mode: SendMode;
  report: ReportKind;
}
```

3. In `NotifyStore`, add after `subscriptions`:

```ts
  /** notification_company_recipients: who gets the whole-company report, on which cadences. */
  companyRecipients(cadences: Cadence[]): Promise<{ employeeId: string; cadence: Cadence }[]>;
```

4. Change `markOpened`'s doc and return type:

```ts
  /** Stamp a send's first open (the digest's "Open in dashboard" click); its recipient and report kind, or null for an unknown id. */
  markOpened(sendId: string): Promise<{ employeeId: string; department: string | null; report: ReportKind } | null>;
```

5. Replace `keyMatch`, and add a shared reader above `supabaseNotifyStore`:

```ts
const keyMatch = (k: SendKey) => ({ employee_id: k.employeeId, cadence: k.cadence, period_key: k.periodKey, mode: k.mode, report: k.report });

/** A recipients table (person × cadence) for some cadences, paginated (gotcha #1). */
async function cadenceRows(supabase: SupabaseClient, table: string, cadences: Cadence[]): Promise<{ employeeId: string; cadence: Cadence }[]> {
  const rows = await pageAll<{ employee_id: string; cadence: Cadence }>(
    (a, b) => supabase.from(table).select("employee_id, cadence").in("cadence", cadences).order("employee_id").order("cadence").range(a, b),
    table,
  );
  return rows.map((r) => ({ employeeId: r.employee_id, cadence: r.cadence }));
}
```

6. Replace the `subscriptions` method and add `companyRecipients`:

```ts
    subscriptions: (cadences) => cadenceRows(supabase, "notification_subscriptions", cadences),
    companyRecipients: (cadences) => cadenceRows(supabase, "notification_company_recipients", cadences),
```

7. In `sendStates`, select and return `report`:

```ts
      const rows = await pageAll<{ employee_id: string; cadence: Cadence; period_key: string; report: ReportKind; status: string; attempts: number }>(
        (a, b) =>
          supabase
            .from("notification_sends")
            .select("employee_id, cadence, period_key, report, status, attempts")
            .in("period_key", periodKeys)
            .eq("mode", mode)
            .order("id")
            .range(a, b),
        "sendStates",
      );
      return rows.map((r) => ({ employeeId: r.employee_id, cadence: r.cadence, periodKey: r.period_key, mode, report: r.report, status: r.status, attempts: r.attempts }));
```

8. In `markOpened`, select `report` and return it:

```ts
      const { data: send, error } = await supabase.from("notification_sends").select("employee_id, opened_at, report").eq("id", sendId).maybeSingle();
```

and the final line:

```ts
      return { employeeId: send.employee_id as string, department: (emp?.department as string | null) ?? null, report: send.report as ReportKind };
```

(`claimSend` and `finishSend` already match on `keyMatch(key)`, so they now include `report`.)

- [ ] **Step 6: Carry `report` through the memory store**

In `src/lib/notify/memory-store.ts`:

```ts
import type { Cadence, NotifyEmployee, ReportKind } from "./types";
```

After the `SendRow` interface:

```ts
/** A seeded send row; `report` defaults to "personal" (rows written before the company report existed). */
export type SeedSendRow = Omit<SendRow, "report"> & { report?: ReportKind };
```

In `MemorySeed`, add `companyRecipients` and change `sends`:

```ts
  companyRecipients?: { employeeId: string; cadence: Cadence }[];
  sends?: SeedSendRow[];
```

Replace `same` and the `sends` initialiser:

```ts
const same = (a: SendKey, b: SendKey) =>
  a.employeeId === b.employeeId && a.cadence === b.cadence && a.periodKey === b.periodKey && a.mode === b.mode && a.report === b.report;
```

```ts
  const sends: SendRow[] = (seed.sends ?? []).map((s) => ({ ...s, id: s.id ?? newId(), report: s.report ?? "personal", openedAt: s.openedAt ?? null }));
```

Add after `subscriptions`:

```ts
    async companyRecipients(cadences) {
      return (seed.companyRecipients ?? []).filter((s) => cadences.includes(s.cadence));
    },
```

In `markOpened`, return the report:

```ts
      return { employeeId: row.employeeId, department: e?.department ?? null, report: row.report };
```

- [ ] **Step 7: Redirect company opens to the Company page**

Replace the body of `src/lib/notify/opens.ts`:

```ts
import { personHref } from "./digest";
import type { NotifyStore } from "./store";
import { isUuid } from "./types";

/**
 * Where a digest's "Open in dashboard" link lands, after stamping the send's first open: the
 * recipient's own Explore page, or the Company page for the company report. Unknown → Explore.
 */
export async function openRedirectPath(store: Pick<NotifyStore, "markOpened">, sendId: string): Promise<string> {
  if (!isUuid(sendId)) return "/explore";
  const opened = await store.markOpened(sendId);
  if (!opened || opened.report === "company") return "/explore";
  return personHref("", { id: opened.employeeId, department: opened.department });
}
```

- [ ] **Step 8: Keep the cron personal-only for now**

In `src/lib/notify/run-notify.ts`, make every key and already-handled match personal. Task 4 generalises this.

```ts
const sendKey = (deps: RunNotifyDeps, w: { recipient: NotifyEmployee; cadence: Cadence; period: DigestPeriod }): SendKey => ({
  employeeId: w.recipient.id,
  cadence: w.cadence,
  periodKey: w.period.key,
  mode: deps.mode,
  report: "personal",
});
```

and in the `open` filter:

```ts
    const row = states.find((s) => s.employeeId === w.recipient.id && s.cadence === w.cadence && s.periodKey === w.period.key && s.report === "personal");
```

- [ ] **Step 9: Run tests and types**

Run: `npx vitest run src/lib/notify && npx tsc --noEmit`

Expected: all PASS, including the new opens test; tsc reports no errors.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/0019_company_report.sql src/lib/notify/types.ts src/lib/notify/store.ts src/lib/notify/memory-store.ts src/lib/notify/opens.ts src/lib/notify/opens.test.ts src/lib/notify/run-notify.ts
git commit -m "feat(notify): company report recipients table and a report kind on the send log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Build the company digest

**Files:**
- Modify: `src/lib/notify/digest.ts`
- Test: `src/lib/notify/digest.test.ts`

**Interfaces:**
- Consumes: `SectionInput`, `section`, `peopleSection`, `counted`, `teamHref`, `TOP_N` (all existing in digest.ts).
- Produces:
  - Types: `MonthTotal`, `TeamAmount`, `CompanyUsageSection`, `FixedCostsSection`, `CompanyDigest`.
  - `buildCompanyDigest(input: SectionInput): CompanyDigest | null`.
  - `isCompanyDigest(d: Digest | TeamDigest | CompanyDigest): d is CompanyDigest`.
  - `isTeamDigest` widened to accept the same union.

- [ ] **Step 1: Write the failing tests**

In `src/lib/notify/digest.test.ts`, change the imports:

```ts
import { VENDOR_LABEL, type CostType, type Vendor } from "@/lib/types";
import { buildCompanyDigest, buildDigest, buildTeamDigest, isCompanyDigest, isTeamDigest, round2, type DigestInput, type SectionInput, type TeamDigestInput } from "./digest";
```

Append at the end of the file:

```ts
describe("buildCompanyDigest", () => {
  const nowOct = new Date("2026-10-08T07:00:00Z");
  const f = (day: string, source: Vendor, costType: CostType, costUsd: number, employeeId: string | null, department: string | null, model = ""): ShapeFact => ({
    day, source, costType, costUsd, employeeId, department, fullName: null, entityKey: employeeId ?? "org", model,
  });
  const coFacts: ShapeFact[] = [
    f("2026-09-22", "cursor", "overage", 30, "m", "Engineering"),
    f("2026-09-24", "cursor", "overage", 140, "a", "Engineering"),
    f("2026-09-25", "anthropic", "metered", 96, "s", "Data Science"),
    f("2026-09-21", "openrouter", "metered", 42, "l", "Engineering"), // a leaver's spend counts
    f("2026-09-23", "anthropic", "metered", 20, null, null), // unkeyed: no person, no team
    f("2026-09-23", "openrouter", "metered", 12, null, "Data Science"), // a workspace key: a team, no person
    f("2026-09-15", "cursor", "overage", 100, "m", "Engineering"), // previous week
    f("2026-09-01", "claude_team", "overage", 500, "a", "Engineering"), // Claude Team's monthly lump
    f("2026-08-01", "cursor", "seat", 310, "m", "Engineering"),
    f("2026-08-01", "other", "subscription", 90, null, "Engineering", "Figma AI"),
    f("2026-09-01", "cursor", "seat", 300, "m", "Engineering"),
    f("2026-09-01", "other", "subscription", 90, null, "Engineering", "Figma AI"),
  ];
  const coInput = (over: Partial<SectionInput> = {}): SectionInput => ({
    employeesById: byId, facts: coFacts, period: periodFor("weekly", "2026-W39", nowOct), now: nowOct, sourceHorizons: {}, toolColors: {},
    freshness: [], missingImports: [], baseUrl: "https://x.test", includeFixed: false, ...over,
  });
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const d = buildCompanyDigest(coInput())!;

  it("is usage only, company-wide: everyone's usage and usage tied to no one, against the previous week", () => {
    expect(d).toMatchObject({ kind: "company", dashboardUrl: "https://x.test/explore", totalUsd: null });
    expect(d.usage).toMatchObject({ basis: "usage", headlineUsd: 340, prevUsd: 100, headcount: 4 }); // 4 active; the leaver isn't headcount
  });

  it("ignores the fixed-costs setting: usage and seats & subscriptions are always apart", () => {
    expect(buildCompanyDigest(coInput({ includeFixed: true }))!.usage).toMatchObject({ basis: "usage", headlineUsd: 340 });
  });

  it("ranks teams as Explore does (the fact's department, else the person's), with no-team usage apart", () => {
    expect(d.usage.teams).toEqual([
      { department: "Engineering", usd: 212, href: "https://x.test/explore/Engineering" },
      { department: "Data Science", usd: 108, href: "https://x.test/explore/Data%20Science" },
    ]);
    expect(d.usage).toMatchObject({ otherTeamsCount: 0, otherTeamsUsd: 0, unattributedUsd: 20 });
  });

  it("ranks people company-wide; usage tied to no person stays out of the people", () => {
    expect(d.usage.top.map((p) => [p.name, p.usd])).toEqual([["Alex Kim", 140], ["Sam Lee", 96], ["Former Person", 42], ["Priya Nair", 30]]);
    expect(d.usage.top[1].href).toBe("https://x.test/explore/Data%20Science/s");
    expect(d.usage).toMatchObject({ othersCount: 0, othersUsd: 32, teamLevelUsd: 32 }); // $20 unkeyed + $12 workspace key
  });

  it("beyond the top five: +N teams and +N others, and every part adds up to the headline to the cent", () => {
    const many = Array.from({ length: 7 }, (_, i) => emp(`p${i}`, `Person ${i}`, { department: `T${i}` }));
    const facts7 = [...many.map((e, i) => f("2026-09-22", "cursor", "overage", 70.333 - i * 10, e.id, e.department)), f("2026-09-22", "anthropic", "metered", 5, null, null)];
    const u = buildCompanyDigest(coInput({ employeesById: new Map(many.map((e) => [e.id, e])), facts: facts7 }))!.usage;
    expect(u).toMatchObject({ otherTeamsCount: 2, othersCount: 2, unattributedUsd: 5, teamLevelUsd: 5 });
    expect(u.teams.map((t) => t.department)).toEqual(["T0", "T1", "T2", "T3", "T4"]);
    expect(round2(sum(u.teams.map((t) => t.usd)) + u.otherTeamsUsd + u.unattributedUsd)).toBe(u.headlineUsd);
    expect(round2(sum(u.top.map((p) => p.usd)) + u.othersUsd)).toBe(u.headlineUsd);
  });

  it("seats & subscriptions: a weekly is the week's share of the monthly bill, compared month on month", () => {
    // September's bill $390 ($300 seat + $90 subscription) over 30 days = $13/day; August's was $400
    expect(d.fixed).toMatchObject({ basis: "total", headlineUsd: 91, month: null, monthTotal: { label: "September", usd: 390, prevLabel: "August", prevUsd: 400, deltaPct: -2.5 } });
    expect(d.fixed.byTool.map((t) => [t.key, t.usd])).toEqual([["cursor", 70], ["other:Figma AI", 21]]);
  });

  it("a week spanning two months takes each month's share; the month line is the month the week ends in", () => {
    const oct = [...coFacts, f("2026-10-01", "cursor", "seat", 310, "m", "Engineering")];
    const w40 = buildCompanyDigest(coInput({ facts: oct, period: periodFor("weekly", "2026-W40", nowOct) }))!;
    expect(w40.fixed.headlineUsd).toBe(79); // Sep 28–30: 3 × $13; Oct 1–4: 4 × ($310 / 31)
    expect(w40.fixed.monthTotal).toEqual({ label: "October", usd: 310, prevLabel: "September", prevUsd: 390, deltaPct: -20.5 });
    expect(w40.usage.headlineUsd).toBe(0); // a weekly still goes out with no usage
  });

  it("the first month with fixed costs has nothing to compare with", () => {
    const first = buildCompanyDigest(coInput({ facts: coFacts.filter((x) => !x.day.startsWith("2026-08")) }))!;
    expect(first.fixed.monthTotal).toMatchObject({ usd: 390, prevUsd: 0, deltaPct: null });
  });

  it("a daily carries the day's share, and a day with no usage is no report, whatever the bill", () => {
    const fri = buildCompanyDigest(coInput({ period: periodFor("daily", "2026-09-25", nowOct) }))!;
    expect(fri.usage.headlineUsd).toBe(96);
    expect(fri.fixed.headlineUsd).toBe(13);
    expect(buildCompanyDigest(coInput({ period: periodFor("daily", "2026-09-28", nowOct) }))).toBeNull();
  });

  it("monthly: usage includes Claude Team's lump, the bill as posted vs last month, and a total of every fact in the month", () => {
    const sep = buildCompanyDigest(coInput({ period: periodFor("monthly", "2026-09", nowOct) }))!;
    expect(sep.usage.headlineUsd).toBe(940);
    expect(sep.fixed).toMatchObject({ headlineUsd: 390, prevUsd: 400, deltaPct: -2.5, monthTotal: null });
    expect(sep.totalUsd).toBe(1330);
    expect(sep.totalUsd).toBe(round2(sep.usage.headlineUsd + sep.fixed.headlineUsd));
  });

  it("caveats cover the sources used and the seats' sources, never a subscription's", () => {
    const stale = (source: Vendor) => ({ source, lastSyncFailed: true, lastSuccessDay: "2026-09-20" });
    const facts3 = [
      f("2026-09-23", "anthropic", "metered", 20, "m", "Engineering"),
      f("2026-09-01", "cursor", "seat", 300, "m", "Engineering"),
      f("2026-09-01", "openrouter", "subscription", 50, null, "Engineering", "platform fee"),
    ];
    const caveats = buildCompanyDigest(coInput({ facts: facts3, freshness: (["anthropic", "cursor", "openrouter", "openai"] as Vendor[]).map(stale) }))!.caveats;
    expect(caveats).toHaveLength(2);
    expect(caveats.join("\n")).toContain(VENDOR_LABEL.anthropic);
    expect(caveats.join("\n")).toContain(VENDOR_LABEL.cursor);
  });
});
```

Also, in the existing `describe("isTeamDigest", …)`, add:

```ts
  it("tells the company report apart from both", () => {
    const company = buildCompanyDigest(input())!;
    expect(isCompanyDigest(company)).toBe(true);
    expect(isTeamDigest(company)).toBe(false);
    expect(isCompanyDigest(buildDigest(input())!)).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/notify/digest.test.ts`

Expected: FAIL with `buildCompanyDigest is not a function` (or an import error for `isCompanyDigest`).

- [ ] **Step 3: Add the types**

In `src/lib/notify/digest.ts`, after `MonthContext`/`DigestSection`:

```ts
/** A month of fixed costs as posted, against the month before: the only real movement in a fixed bill. */
export interface MonthTotal {
  label: string; // "October"
  usd: number;
  prevLabel: string; // "September"
  prevUsd: number;
  deltaPct: number | null; // null when the previous month was $0
}

/**
 * Every seat & subscription in the company. A daily/weekly headline is a share of the monthly bill, so
 * its change vs the day/week before would only reflect month lengths: those cadences compare whole
 * months instead (`monthTotal`). A monthly's headline already is the month: `monthTotal` is null.
 */
export interface FixedCostsSection extends DigestSection {
  monthTotal: MonthTotal | null;
}
```

After `ReportsSection`:

```ts
export interface TeamAmount {
  department: string;
  usd: number;
  href: string;
}

/**
 * The company's usage, ranked by person (a ReportsSection whose members are every employee, so
 * `teamLevelUsd` is the usage that belongs to no person: unkeyed rows, workspace keys) and by team.
 */
export interface CompanyUsageSection extends ReportsSection {
  teams: TeamAmount[]; // top TOP_N departments by usage
  otherTeamsCount: number;
  /** The headline minus the top teams and unattributed usage, exact to the cent. */
  otherTeamsUsd: number;
  unattributedUsd: number; // usage with no department: Explore's "Unattributed"
}
```

After `TeamDigest`:

```ts
/** The whole-company report: its own recipients and its own DM (notification_company_recipients). */
export interface CompanyDigest {
  kind: "company";
  period: DigestPeriod;
  usage: CompanyUsageSection;
  fixed: FixedCostsSection;
  /** Monthly only: every fact in the month, usage and fixed: Explore's company total. */
  totalUsd: number | null;
  caveats: string[];
  dashboardUrl: string;
}
```

Replace `isTeamDigest` and add `isCompanyDigest`:

```ts
/** Person digests carry no `kind`; team digests are `kind: "team"`, the company report `kind: "company"`. */
export function isTeamDigest(d: Digest | TeamDigest | CompanyDigest): d is TeamDigest {
  return "kind" in d && d.kind === "team";
}

export function isCompanyDigest(d: Digest | TeamDigest | CompanyDigest): d is CompanyDigest {
  return "kind" in d && d.kind === "company";
}
```

(`UNATTRIBUTED`, used below, is already imported from `@/lib/explore/shape`.)

- [ ] **Step 4: Split caveats into sources and caveats**

Replace `caveatsOf` with:

```ts
/** Same basis as the headline: a seat the digest doesn't count doesn't make the recipient a "user" of that source. */
function sourcesIn(pop: ShapeFact[], input: SectionInput): string[] {
  const { period } = input;
  return counted(pop, input).filter((f) => inRange(f, period.buckets[0].from, period.toExclusive)).map((f) => f.source);
}

function caveatsOf(sources: string[], input: SectionInput): string[] {
  const { period, freshness, missingImports } = input;
  return caveatsFor({ period, sourcesUsed: new Set(sources), freshness, missingImports });
}
```

Update the two call sites:
- In `buildDigest`: `caveats: caveatsOf(sourcesIn([...youFacts, ...reportFacts], input), input),`
- In `buildTeamDigest`: `caveats: caveatsOf(sourcesIn(pop, input), input),`

- [ ] **Step 5: Add the month comparison, team ranking and the builder**

Append to `src/lib/notify/digest.ts`:

```ts
const prevMonthOf = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

/** The month the period ends in, as posted, against the month before. */
function monthTotal(pop: ShapeFact[], period: DigestPeriod): MonthTotal {
  const lastDay = new Date(Date.parse(`${period.toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const month = lastDay.slice(0, 7);
  const prev = prevMonthOf(month);
  const usd = round2(total(pop.filter((f) => f.day.startsWith(month))));
  const prevUsd = round2(total(pop.filter((f) => f.day.startsWith(prev))));
  return {
    label: MONTHS[Number(month.slice(5, 7)) - 1],
    usd,
    prevLabel: MONTHS[Number(prev.slice(5, 7)) - 1],
    prevUsd,
    deltaPct: prevUsd > 0 ? Math.round(((usd - prevUsd) / prevUsd) * 1000) / 10 : null,
  };
}

/** This period's usage by department, Explore's grouping (rankTeams): the fact's department, else the person's. */
function teamRanking(cur: ShapeFact[], headlineUsd: number, baseUrl: string) {
  const byDept = sumBy(cur, (f) => f.department ?? UNATTRIBUTED);
  const unattributedUsd = round2(byDept.get(UNATTRIBUTED) ?? 0);
  byDept.delete(UNATTRIBUTED);
  const ranked = [...byDept]
    .map(([department, usd]) => ({ department, usd: round2(usd), href: teamHref(baseUrl, department) }))
    .filter((t) => t.usd > 0)
    .sort((a, b) => b.usd - a.usd || a.department.localeCompare(b.department));
  const teams = ranked.slice(0, TOP_N);
  return {
    teams,
    otherTeamsCount: ranked.length - teams.length,
    // The remainder of the headline, so top teams + others + unattributed equal it to the cent.
    otherTeamsUsd: Math.max(0, round2(headlineUsd - unattributedUsd - teams.reduce((s, t) => s + t.usd, 0))),
    unattributedUsd,
  };
}

/**
 * The whole-company report, or null (a daily with no usage: the bill alone never makes a daily).
 * Usage and seats & subscriptions are always apart, whatever the fixed-costs setting (`includeFixed`
 * is ignored). Usage ranks every employee (leavers' spend counts; headcount is active people) and
 * every department. The second section is every seat & subscription, person-less ones included.
 * Only seats count for caveats: subscriptions come from recurring costs, which no sync can leave stale.
 */
export function buildCompanyDigest(input: SectionInput): CompanyDigest | null {
  const { employeesById, facts, period, baseUrl } = input;
  const usageInput: SectionInput = { ...input, includeFixed: false };
  const fixedInput: SectionInput = { ...input, includeFixed: true };
  const usagePop = facts.filter((f) => !isFixed(f));
  const fixedPop = facts.filter(isFixed);

  const people = peopleSection(usagePop, [...employeesById.keys()], usageInput);
  if (period.cadence === "daily" && people.headlineUsd === 0) return null;

  const cur = counted(usagePop, usageInput).filter((f) => inRange(f, period.from, period.toExclusive));
  const isPerson = (f: ShapeFact) => f.employeeId !== null && employeesById.has(f.employeeId);
  const usage: CompanyUsageSection = {
    ...people,
    teamLevelUsd: round2(total(cur.filter((f) => !isPerson(f)))),
    ...teamRanking(cur, people.headlineUsd, baseUrl),
  };
  const monthly = period.cadence === "monthly";
  const fixed: FixedCostsSection = { ...section(fixedPop, fixedInput), month: null, monthTotal: monthly ? null : monthTotal(fixedPop, period) };

  return {
    kind: "company",
    period,
    usage,
    fixed,
    totalUsd: monthly ? round2(total(facts.filter((f) => inRange(f, period.from, period.toExclusive)))) : null,
    caveats: caveatsOf([...sourcesIn(usagePop, usageInput), ...sourcesIn(fixedPop.filter((f) => f.costType === "seat"), fixedInput)], input),
    dashboardUrl: `${baseUrl}/explore`,
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/notify/digest.test.ts && npx tsc --noEmit`

Expected: all PASS (including every existing caveat test after the refactor), and no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/notify/digest.ts src/lib/notify/digest.test.ts
git commit -m "feat(notify): build the whole-company digest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Render and deliver the company report

**Files:**
- Modify: `src/lib/notify/render.ts`
- Modify: `src/lib/notify/deliver.ts`
- Test: `src/lib/notify/render.test.ts`, `src/lib/notify/deliver.test.ts`

**Interfaces:**
- Consumes: `CompanyDigest`, `CompanyUsageSection`, `FixedCostsSection`, `MonthTotal` (Task 2).
- Produces:
  - `CompanyChartFileIds { company?: string }`.
  - `companyChartTitle(d: CompanyDigest): string`.
  - `renderCompanyDigest(d: CompanyDigest, files: CompanyChartFileIds, opts?: RenderOpts): RenderedDigest`.
  - `chartLayoutsForCompany(d: CompanyDigest): { company: ChartLayout }`.
  - `deliverCompanyDigest(args: DeliverArgs & { digest: CompanyDigest; previewFor?: string }): Promise<string>`.

- [ ] **Step 1: Write the failing render tests**

In `src/lib/notify/render.test.ts`, change the imports:

```ts
import type { CompanyDigest, Digest, DigestSection, TeamDigest } from "./digest";
import { chartHeadline, chartSpan, chartTitle, companyChartTitle, deltaText, escapeMrkdwn, renderCompanyDigest, renderDigest, renderTeamDigest, teamChartTitle } from "./render";
```

Append:

```ts
const companyDigest = (over: Partial<CompanyDigest> = {}): CompanyDigest => ({
  kind: "company",
  period: periodFor("weekly", "2026-W39", now),
  usage: {
    ...sec({ headlineUsd: 340, prevUsd: 100, deltaPct: 240 }),
    headcount: 142,
    top: [{ employeeId: "a", name: "Alex Kim", usd: 140, href: "https://x.test/explore/Engineering/a" }],
    othersCount: 3, othersUsd: 200, teamLevelUsd: 32,
    teams: [
      { department: "Engineering", usd: 212, href: "https://x.test/explore/Engineering" },
      { department: "R&D <Ops>", usd: 108, href: "https://x.test/explore/R%26D%20%3COps%3E" },
    ],
    otherTeamsCount: 0, otherTeamsUsd: 0, unattributedUsd: 20,
  },
  fixed: {
    ...sec({
      basis: "total", headlineUsd: 91, prevUsd: 91, deltaPct: 0, month: null,
      byTool: [{ key: "cursor", label: "Cursor", color: "#f59e0b", usd: 70 }, { key: "other:Figma AI", label: "Figma AI", color: "#888888", usd: 21 }],
    }),
    monthTotal: { label: "September", usd: 390, prevLabel: "August", prevUsd: 400, deltaPct: -2.5 },
  },
  totalUsd: null,
  caveats: ["⚠ Cursor data may be incomplete (last synced 26 Sep)"],
  dashboardUrl: "https://x.test/explore",
  ...over,
});

describe("renderCompanyDigest", () => {
  const { blocks, text } = renderCompanyDigest(companyDigest(), { company: "F1" });
  const fixedAt = (b: Record<string, unknown>[]) => b.findIndex((x) => x.type === "section" && mrk(x).startsWith("*SEATS"));

  it("leads with the company header", () => {
    expect(blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "📊 Company AI spend · 21–27 Sep 2026", emoji: true } });
  });

  it("labels the usage section with the headcount and draws its chart", () => {
    expect(mrk(blocks[1])).toBe("*COMPANY · 142 PEOPLE*");
    expect(blocks[2]).toEqual({ type: "image", slack_file: { id: "F1" }, alt_text: "COMPANY (142 PEOPLE) · USAGE, 21–27 SEP 2026: $340 · ▲ 240% vs previous week" });
  });

  it("lists linked, escaped top teams with unattributed apart, then top people with usage tied to no one apart", () => {
    expect(mrk(blocks[3])).toBe(
      "<https://x.test/explore/Engineering|Engineering> $212 · <https://x.test/explore/R%26D%20%3COps%3E|R&amp;D &lt;Ops&gt;> $108 · unattributed $20.00\n" +
        "<https://x.test/explore/Engineering/a|Alex Kim> $140 · +3 others $168 · not tied to a person $32.00",
    );
    expect(blocks[4]).toEqual({ type: "context", elements: [
      { type: "mrkdwn", text: "Cursor $30.10 · Anthropic API $8.10" },
      { type: "mrkdwn", text: "September so far $142 · on track for ~$190" },
    ] });
  });

  it("counts the teams beyond the top five", () => {
    const u = companyDigest().usage;
    const line = (n: number) => mrk(renderCompanyDigest(companyDigest({ usage: { ...u, otherTeamsCount: n, otherTeamsUsd: 5 } }), {}).blocks[2]);
    expect(line(1)).toContain(" · +1 team $5.00 · unattributed $20.00");
    expect(line(3)).toContain(" · +3 teams $5.00 · ");
  });

  it("says so when nobody used anything", () => {
    const u = companyDigest().usage;
    const quiet = { ...u, headlineUsd: 0, top: [], othersCount: 0, othersUsd: 0, teamLevelUsd: 0, teams: [], unattributedUsd: 0 };
    expect(renderCompanyDigest(companyDigest({ usage: quiet }), {}).blocks.some((b) => b.type === "section" && mrk(b) === "No usage this week")).toBe(true);
  });

  it("shows seats & subscriptions as text: a week's share, then the month against the month before", () => {
    const i = fixedAt(blocks);
    expect(blocks[i - 1]).toEqual({ type: "divider" });
    expect(mrk(blocks[i])).toBe("*SEATS &amp; SUBSCRIPTIONS*\n*$91.00* total · a week's share of the monthly bill");
    expect(blocks[i + 1]).toEqual({ type: "context", elements: [
      { type: "mrkdwn", text: "Cursor $70.00 · Figma AI $21.00" },
      { type: "mrkdwn", text: "September $390 · ▼ 3% vs August" },
    ] });
    expect(blocks.some((b) => b.type === "image" && (b as { slack_file: { id: string } }).slack_file.id !== "F1")).toBe(false);
  });

  it("the month line has no change with nothing before it, and reads 'no change' under half a percent", () => {
    const fx = companyDigest().fixed;
    const monthLine = (monthTotal: CompanyDigest["fixed"]["monthTotal"]) => {
      const b = renderCompanyDigest(companyDigest({ fixed: { ...fx, monthTotal } }), {}).blocks;
      return (b[fixedAt(b) + 1] as { elements: { text: string }[] }).elements[1].text;
    };
    expect(monthLine({ label: "September", usd: 390, prevLabel: "August", prevUsd: 0, deltaPct: null })).toBe("September $390");
    expect(monthLine({ label: "September", usd: 390, prevLabel: "August", prevUsd: 389, deltaPct: 0.3 })).toBe("September $390 · no change vs August");
  });

  it("a daily's figure is a day's share", () => {
    const b = renderCompanyDigest(companyDigest({ period: periodFor("daily", "2026-09-25", now) }), {}).blocks;
    expect(mrk(b[fixedAt(b)])).toContain("total · a day's share of the monthly bill");
  });

  it("a monthly compares the bill with last month and ends with the month's total", () => {
    const fx = { ...companyDigest().fixed, headlineUsd: 390, prevUsd: 400, deltaPct: -2.5, monthTotal: null };
    const b = renderCompanyDigest(companyDigest({ period: periodFor("monthly", "2026-08", now), fixed: fx, totalUsd: 1330 }), {}).blocks;
    expect(mrk(b[fixedAt(b)])).toBe("*SEATS &amp; SUBSCRIPTIONS*\n*$390* total · ▼ 3% vs previous month");
    expect(b[fixedAt(b) + 1]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "Cursor $70.00 · Figma AI $21.00" }] });
    expect(mrk(b[fixedAt(b) + 2])).toBe("*August 2026 total $1,330* · usage + seats &amp; subscriptions");
  });

  it("ends with caveats and a button to the Company page, or the send's tracked link", () => {
    expect(blocks.at(-2)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "⚠ Cursor data may be incomplete (last synced 26 Sep)" }] });
    expect(blocks.at(-1)).toMatchObject({ type: "actions", elements: [{ type: "button", url: "https://x.test/explore" }] });
    const tracked = renderCompanyDigest(companyDigest(), {}, { openUrl: "https://x.test/api/digest/open/abc" }).blocks.at(-1);
    expect(tracked).toMatchObject({ elements: [{ url: "https://x.test/api/digest/open/abc" }] });
  });

  it("has an escaped plain-text fallback with both figures, and takes the preview line", () => {
    expect(text).toBe("Company AI spend · 21–27 Sep 2026: usage $340 · seats &amp; subscriptions $91.00");
    const r = renderCompanyDigest(companyDigest(), {}, { previewFor: "Priya Nair (company weekly)" });
    expect(r.blocks[0]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "🔍 Preview · would send to Priya Nair (company weekly)" }] });
  });
});

describe("companyChartTitle", () => {
  it("names the company, its headcount, the basis and the headline's period", () => {
    expect(companyChartTitle(companyDigest())).toBe("COMPANY (142 PEOPLE) · USAGE, 21–27 SEP 2026");
  });
});
```

- [ ] **Step 2: Write the failing deliver tests**

In `src/lib/notify/deliver.test.ts`, change the imports:

```ts
import { chartLayoutsFor, chartLayoutsForCompany, chartLayoutsForTeam, deliverCompanyDigest, deliverDigest, deliverTeamDigest, PostOutcomeUnknownError, resolveSlackUser, SLACK_USER_TTL_MS } from "./deliver";
import { buildCompanyDigest, buildDigest, buildTeamDigest } from "./digest";
```

After `const personDigest = …`:

```ts
const companyDigest = buildCompanyDigest(base)!;
```

Append:

```ts
describe("chartLayoutsForCompany", () => {
  it("is one chart, of the company's usage", () => {
    const l = chartLayoutsForCompany(companyDigest);
    expect(Object.keys(l)).toEqual(["company"]);
    expect(l.company.title).toBe("COMPANY (2 PEOPLE) · USAGE, 21–27 SEP 2026");
    expect(l.company.headline).toEqual(chartHeadline(companyDigest.usage, "previous week"));
    expect(l.company.bars).toHaveLength(8);
  });
});

describe("deliverCompanyDigest", () => {
  it("uploads the company chart and DMs the report with its tracked link", async () => {
    const s = fakeSlack();
    const ts = await deliverCompanyDigest({ ...args(s.client), digest: companyDigest, openUrl: "https://x.test/api/digest/open/abc" });
    expect(ts).toBe("ts1");
    expect(s.uploads).toEqual([{ name: "ai-spend-company.png", title: "COMPANY (2 PEOPLE) · USAGE, 21–27 SEP 2026" }]);
    expect(JSON.stringify(s.posts[0].blocks[0])).toContain("Company AI spend");
    expect(JSON.stringify(s.posts[0].blocks.at(-1))).toContain("https://x.test/api/digest/open/abc");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/notify/render.test.ts src/lib/notify/deliver.test.ts`

Expected: FAIL. `renderCompanyDigest`, `companyChartTitle`, `chartLayoutsForCompany` and `deliverCompanyDigest` are not functions.

- [ ] **Step 4: Implement rendering**

In `src/lib/notify/render.ts`:

1. Imports:

```ts
import { round2, type CompanyDigest, type CompanyUsageSection, type Digest, type DigestSection, type FixedCostsSection, type MonthTotal, type ReportsSection, type TeamDigest, type ToolAmount } from "./digest";
import { CADENCE_UNIT, CHART_SPAN, type DigestPeriod } from "./schedule";
```

2. After `TeamChartFileIds`:

```ts
export interface CompanyChartFileIds { company?: string }
```

3. After `teamChartTitle`:

```ts
export function companyChartTitle(d: CompanyDigest): string {
  return `COMPANY (${people(d.usage.headcount)}) · ${d.usage.basis.toUpperCase()}, ${d.period.label.toUpperCase()}`;
}
```

4. Replace `teamTopLine` with a shared people line plus the team wrapper:

```ts
/**
 * A group's top people. "Others" counts people only; spend that belongs to no member (`teamLevelUsd`)
 * is its own item, named by `restLabel`, so neither is hidden inside the other. Rounding cents alone
 * show nothing. Null when there is nothing to list.
 */
function peopleLine(r: ReportsSection, restLabel: string): string | null {
  const parts = r.top.map((p) => `<${p.href}|${escapeMrkdwn(p.name)}> ${formatUsd(p.usd)}`);
  const rest = r.teamLevelUsd ?? 0;
  if (r.othersCount) parts.push(`+${r.othersCount} others ${formatUsd(Math.max(0, round2(r.othersUsd - rest)))}`);
  if (rest > 0) parts.push(`${restLabel} ${formatUsd(rest)}`);
  return parts.length ? parts.join(" · ") : null;
}

const teamTopLine = (r: ReportsSection, unit: string): string => peopleLine(r, "team-level costs") ?? `No usage from this team this ${unit}`;

/** The company's top teams (linked), the rest, then usage with no team (Explore's "Unattributed") apart. */
function teamsLine(u: CompanyUsageSection): string | null {
  const parts = u.teams.map((t) => `<${t.href}|${escapeMrkdwn(t.department)}> ${formatUsd(t.usd)}`);
  if (u.otherTeamsCount) parts.push(`+${u.otherTeamsCount} ${u.otherTeamsCount === 1 ? "team" : "teams"} ${formatUsd(u.otherTeamsUsd)}`);
  if (u.unattributedUsd > 0) parts.push(`unattributed ${formatUsd(u.unattributedUsd)}`);
  return parts.length ? parts.join(" · ") : null;
}

function companyLines(u: CompanyUsageSection, unit: string): string {
  const lines = [teamsLine(u), peopleLine(u, "not tied to a person")].filter((l): l is string => l !== null);
  return lines.length ? lines.join("\n") : `No usage this ${unit}`;
}
```

5. After `sectionBlocks`:

```ts
const FIXED_LABEL = "SEATS & SUBSCRIPTIONS";
const SHARE_OF_MONTH: Record<Cadence, string> = { daily: "a day's share of the monthly bill", weekly: "a week's share of the monthly bill", monthly: "" };

/** "October $18,277 · ▼ 1% vs September": the bill's real movement. Nothing before it → the figure alone. */
function monthTotalLine(m: MonthTotal): string {
  if (m.deltaPct === null) return `${m.label} ${formatUsd(m.usd)}`;
  const change = Math.abs(m.deltaPct) < 0.5 ? "no change" : `${m.deltaPct > 0 ? "▲" : "▼"} ${Math.round(Math.abs(m.deltaPct)).toLocaleString("en-US")}%`;
  return `${m.label} ${formatUsd(m.usd)} · ${change} vs ${m.prevLabel}`;
}

/**
 * The company's seats & subscriptions, text only (a day's share is flat across a month, so a chart
 * would say nothing). A daily/weekly figure is a share of the bill (its change vs the day/week before
 * would only be the month's length), so it says so, and the month line compares whole months instead.
 */
function fixedBlocks(s: FixedCostsSection, period: DigestPeriod): SlackBlock[] {
  const change = s.monthTotal ? SHARE_OF_MONTH[period.cadence] : deltaText(s, period.compareTo);
  const lines = [toolsLine(s.byTool), s.monthTotal ? monthTotalLine(s.monthTotal) : null].filter((l): l is string => l !== null);
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${escapeMrkdwn(FIXED_LABEL)}*\n*${formatUsd(s.headlineUsd)}* ${s.basis} · ${change}` } },
    ...(lines.length ? [context(lines)] : []),
  ];
}
```

6. After `renderTeamDigest`:

```ts
/** The whole-company report → Block Kit (the cron's company DMs, the admin preview and test sends). */
export function renderCompanyDigest(d: CompanyDigest, files: CompanyChartFileIds, opts: RenderOpts = {}): RenderedDigest {
  const unit = CADENCE_UNIT[d.period.cadence];
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: `📊 Company AI spend · ${d.period.label}`, emoji: true } },
    ...sectionBlocks(`COMPANY · ${people(d.usage.headcount)}`, d.usage, files.company, companyChartTitle(d), d.period.compareTo, companyLines(d.usage, unit)),
    { type: "divider" },
    ...fixedBlocks(d.fixed, d.period),
  ];
  // Monthly: both sections together, which is the Company page's total for the month.
  if (d.totalUsd !== null) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${d.period.label} total ${formatUsd(d.totalUsd)}* · usage + ${escapeMrkdwn("seats & subscriptions")}` } });
  }
  if (d.caveats.length) blocks.push(context(d.caveats.map(escapeMrkdwn)));
  blocks.push(dashboardButton(opts.openUrl ?? d.dashboardUrl));

  const text = `Company AI spend · ${d.period.label}: usage ${formatUsd(d.usage.headlineUsd)} · ${escapeMrkdwn("seats & subscriptions")} ${formatUsd(d.fixed.headlineUsd)}`;
  return withLead({ blocks, text }, opts);
}
```

- [ ] **Step 5: Implement delivery**

In `src/lib/notify/deliver.ts`:

```ts
import type { CompanyDigest, Digest, TeamDigest } from "./digest";
import { chartHeadline, chartSpan, chartTitle, companyChartTitle, renderCompanyDigest, renderDigest, renderTeamDigest, teamChartTitle, type RenderedDigest } from "./render";
```

After `chartLayoutsForTeam`:

```ts
/** The company report has one chart, of its usage (seats & subscriptions are text only). */
export function chartLayoutsForCompany(d: CompanyDigest): { company: ChartLayout } {
  const headline = chartHeadline(d.usage, d.period.compareTo);
  return { company: chartLayout(companyChartTitle(d), d.usage.chart, d.usage.chartTools, d.usage.byTool, { headline, caption: chartSpan(d.period.cadence) }) };
}
```

After `deliverTeamDigest`:

```ts
/** The whole-company report (the cron's company sends and admin test sends). */
export function deliverCompanyDigest(args: DeliverArgs & { digest: CompanyDigest; previewFor?: string }): Promise<string> {
  const { digest, previewFor, banner, openUrl } = args;
  return deliverRendered({ ...args, layouts: chartLayoutsForCompany(digest), render: (files) => renderCompanyDigest(digest, files, { previewFor, banner, openUrl }) });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/notify/render.test.ts src/lib/notify/deliver.test.ts && npx tsc --noEmit`

Expected: all PASS. This includes the existing `renderTeamDigest` "top-people line" tests, which pin the `teamTopLine` refactor. tsc reports no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/notify/render.ts src/lib/notify/render.test.ts src/lib/notify/deliver.ts src/lib/notify/deliver.test.ts
git commit -m "feat(notify): render and deliver the company report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Schedule the company report in the cron

**Files:**
- Modify: `src/lib/notify/context.ts`
- Modify: `src/lib/notify/run-notify.ts`
- Test: `src/lib/notify/context.test.ts`, `src/lib/notify/run-notify.test.ts`

**Interfaces:**
- Consumes:
  - `buildCompanyDigest` (Task 2) and `deliverCompanyDigest` (Task 3).
  - `NotifyStore.companyRecipients` and `SendKey.report` (Task 1).
  - `openRedirectPath` (Task 1).
- Produces: `companyDigestFor(ctx: NotifyContext, period: DigestPeriod): CompanyDigest | null`.

- [ ] **Step 1: Write the failing context test**

In `src/lib/notify/context.test.ts`:

```ts
import { companyDigestFor, digestFor, factsWindow, loadNotifyContext, teamDigestFor } from "./context";
```

Append:

```ts
describe("companyDigestFor", () => {
  it("builds the company report from the shared context, linked to the Company page", async () => {
    const store = memoryStore({
      employees: [emp("m"), emp("s", { department: "Data" })],
      facts: [fact("2026-09-22", 10, "m"), { ...fact("2026-09-23", 5, "s"), department: "Data" }],
      fixedCosts: { orgInclude: true, departments: {}, employees: {} },
    });
    const ctx = await loadNotifyContext(store, now, "https://x.test");
    const d = companyDigestFor(ctx, periodFor("weekly", "2026-W39", now))!;
    expect(d).toMatchObject({ kind: "company", dashboardUrl: "https://x.test/explore" });
    expect(d.usage).toMatchObject({ basis: "usage", headlineUsd: 15, headcount: 2 }); // the org's "include" setting doesn't apply
  });
});
```

(`FixedCostSettings` on `main` is `{ orgInclude, departments, employees }`; the abandoned branch's `ownerTeam` does not exist here.)

- [ ] **Step 2: Write the failing cron tests**

In `src/lib/notify/run-notify.test.ts`, add the import:

```ts
import { openRedirectPath } from "./opens";
```

Append:

```ts
describe("runNotify: company report", () => {
  const withCompany = (over: MemorySeed = {}) =>
    seed({
      companyRecipients: [{ employeeId: "m", cadence: "weekly" }, { employeeId: "gareth", cadence: "daily" }, { employeeId: "gone", cadence: "weekly" }],
      ...over,
    });
  const header = (p: { blocks: unknown[] }) => JSON.stringify(p.blocks[0]);

  it("sends the company report as its own DM beside a personal digest for the same period, once", async () => {
    const store = memoryStore(withCompany(), () => MONDAY.getTime());
    const slack = fakeSlack();
    expect(await runNotify(deps(store, slack.client))).toMatchObject({ sent: 4, failed: 0 });
    const toM = slack.posts.filter((p) => p.channel === "D-U-m");
    expect(toM).toHaveLength(2);
    expect(toM.some((p) => header(p).includes("Company AI spend · 21–27 Sep 2026"))).toBe(true);
    expect(toM.some((p) => header(p).includes("Your AI spend · 21–27 Sep 2026"))).toBe(true);
    expect(store.sends.filter((s) => s.employeeId === "m").map((s) => s.report).sort()).toEqual(["company", "personal"]);
    expect(await runNotify(deps(store, slack.client))).toMatchObject({ sent: 0, alreadyHandled: 4 });
  });

  it("a company recipient needs no personal subscription and no reports; leavers get nothing", async () => {
    const store = memoryStore(withCompany(), () => MONDAY.getTime());
    const slack = fakeSlack();
    await runNotify(deps(store, slack.client));
    const toG = slack.posts.filter((p) => p.channel === "D-U-gareth");
    expect(toG).toHaveLength(1);
    expect(header(toG[0])).toContain("Company AI spend · 25 Sep 2026");
    expect(store.sends.some((s) => s.employeeId === "gone")).toBe(false);
  });

  it("its tracked button opens the Company page", async () => {
    const store = memoryStore(withCompany(), () => MONDAY.getTime());
    const slack = fakeSlack();
    await runNotify(deps(store, slack.client));
    const post = slack.posts.find((p) => p.channel === "D-U-gareth")!;
    const row = store.sends.find((s) => s.employeeId === "gareth" && s.report === "company")!;
    expect((post.blocks.at(-1) as { elements: { url: string }[] }).elements[0].url).toBe(`https://x.test/api/digest/open/${row.id}`);
    expect(await openRedirectPath(store, row.id!)).toBe("/explore");
  });

  it("a spent personal send for the same period neither blocks the company send nor is taken over by it", async () => {
    const spent = { employeeId: "m", cadence: "weekly" as const, periodKey: "2026-W39", mode: "live" as const, status: "failed", attempts: 3, slackTs: null, detail: "x", updatedAt: "2026-09-28T06:59:00Z" };
    const store = memoryStore(withCompany({ sends: [spent] }), () => MONDAY.getTime());
    expect(await runNotify(deps(store, fakeSlack().client))).toMatchObject({ sent: 3, alreadyHandled: 1 });
    expect(store.sends.find((s) => s.employeeId === "m" && s.report === "company")!.status).toBe("sent");
    expect(store.sends.find((s) => s.employeeId === "m" && s.report === "personal")).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("preview mode names the company report in the would-send line", async () => {
    const store = memoryStore(withCompany({ subscriptions: [] }), () => MONDAY.getTime());
    const slack = fakeSlack();
    await runNotify(deps(store, slack.client, { mode: "preview" }));
    expect(slack.posts.every((p) => p.channel === "D-U-gareth")).toBe(true);
    expect(slack.posts.some((p) => header(p).includes("would send to Person m (company weekly)"))).toBe(true);
    expect(store.sends.every((s) => s.report === "company" && s.mode === "preview")).toBe(true);
  });

  it("logs a company daily with no usage as skipped, never a bill-only DM", async () => {
    const TUESDAY = new Date("2026-09-29T09:30:00Z"); // daily for Monday 28th: no usage that day
    const store = memoryStore(
      withCompany({ subscriptions: [], syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-09-29T06:00:03Z" }] }),
      () => TUESDAY.getTime(),
    );
    const slack = fakeSlack();
    expect(await runNotify(deps(store, slack.client, { now: TUESDAY, clock: () => TUESDAY.getTime() }))).toMatchObject({ sent: 0, skipped: 1 });
    expect(slack.posts).toHaveLength(0);
    expect(store.sends).toEqual([expect.objectContaining({ employeeId: "gareth", report: "company", status: "skipped", detail: "no usage" })]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/notify/context.test.ts src/lib/notify/run-notify.test.ts`

Expected: FAIL. `companyDigestFor` is not a function, and the cron sends no company DMs (for example, `sent: 2` instead of `4`).

- [ ] **Step 4: Add `companyDigestFor`**

In `src/lib/notify/context.ts`:

```ts
import { buildCompanyDigest, buildDigest, buildTeamDigest, type CompanyDigest, type Digest, type SectionInput, type TeamDigest } from "./digest";
```

Append:

```ts
/** The whole-company report: the same for every recipient. Seats & subscriptions are their own section, so no setting applies. */
export function companyDigestFor(ctx: NotifyContext, period: DigestPeriod): CompanyDigest | null {
  return buildCompanyDigest(sectionInput(ctx, period, false));
}
```

- [ ] **Step 5: Send both kinds from the cron**

In `src/lib/notify/run-notify.ts`:

1. Imports:

```ts
import { companyDigestFor, digestFor, loadNotifyContext, syncRunsSince, type NotifyContext } from "./context";
import { deliverCompanyDigest, deliverDigest, PostOutcomeUnknownError, resolveSlackUser, type RenderChart, type SlackRecipient } from "./deliver";
import type { CompanyDigest } from "./digest";
import { isActiveEmployee, type Cadence, type NotifyEmployee, type ReportKind, type SendMode } from "./types";
```

2. Replace `const subs = await store.subscriptions(CADENCES);` with:

```ts
  // Both lists, each (person, cadence) tagged with its DM: someone on both gets two messages.
  const [personal, company] = await Promise.all([store.subscriptions(CADENCES), store.companyRecipients(CADENCES)]);
  const subs: { employeeId: string; cadence: Cadence; report: ReportKind }[] = [
    ...personal.map((s) => ({ ...s, report: "personal" as const })),
    ...company.map((s) => ({ ...s, report: "company" as const })),
  ];
```

3. Change the candidate type and push to carry `report`:

```ts
  const candidates: { recipient: NotifyEmployee; cadence: Cadence; report: ReportKind; slackUser: SlackRecipient | null; day: string }[] = [];
```

```ts
    candidates.push({ recipient, cadence: sub.cadence, report: sub.report, slackUser, day });
```

4. Change the already-handled match (Task 1 put `"personal"` there):

```ts
    const row = states.find((s) => s.employeeId === w.recipient.id && s.cadence === w.cadence && s.periodKey === w.period.key && s.report === w.report);
```

5. Before the final send loop, create the per-run cache and pass it:

```ts
  const ctx = await loadNotifyContext(store, now, deps.baseUrl, { coverage, syncRuns, employees });
  const companyDigests = new Map<string, CompanyDigest | null>(); // by period key: built once per period per run
  for (const w of sendable) {
    if (clock() - start > budget) {
      result.notReached++;
      continue;
    }
    await sendOne(deps, w, ctx, result, { log, previewTarget, companyDigests });
  }
```

6. Replace `sendKey` and add the log helper below it:

```ts
const sendKey = (deps: RunNotifyDeps, w: { recipient: NotifyEmployee; cadence: Cadence; report: ReportKind; period: DigestPeriod }): SendKey => ({
  employeeId: w.recipient.id,
  cadence: w.cadence,
  periodKey: w.period.key,
  mode: deps.mode,
  report: w.report,
});

/** A send's ids for a log line. Personal sends keep their established shape; company ones say so. */
const who = (k: SendKey) => `employee=${k.employeeId} cadence=${k.cadence}${k.report === "company" ? " report=company" : ""}`;
```

7. In `claim`, use it:

```ts
    log(`[notify] claim failed ${who(key)}: ${errorDetail(err)}`);
```

8. Replace `sendOne` with:

```ts
/** One (recipient, cadence, report): claim → build → DM → mark, with every failure contained here. */
async function sendOne(
  deps: RunNotifyDeps,
  w: { recipient: NotifyEmployee; cadence: Cadence; report: ReportKind; slackUser: SlackRecipient; period: DigestPeriod },
  ctx: NotifyContext,
  result: RunNotifyResult,
  { log, previewTarget, companyDigests }: { log: (m: string) => void; previewTarget: NotifyEmployee | undefined; companyDigests: Map<string, CompanyDigest | null> },
): Promise<void> {
  const { store, slack } = deps;
  const { recipient, cadence, period } = w;
  const key = sendKey(deps, w);
  const sendId = await claim(store, key, result, log);
  if (!sendId) return;

  const skip = async () => {
    await store.finishSend(key, { status: "skipped", detail: "no usage" });
    result.skipped++;
  };
  const common = {
    slack,
    renderChart: deps.renderChart,
    slackUserId: w.slackUser.slackUserId,
    openUrl: `${deps.baseUrl}/api/digest/open/${sendId}`,
    log,
    sleep: deps.sleep,
  };
  let posted = false;
  try {
    let ts: string;
    if (w.report === "company") {
      // The same report for everyone it is due to.
      let digest = companyDigests.get(period.key);
      if (digest === undefined) {
        digest = companyDigestFor(ctx, period);
        companyDigests.set(period.key, digest);
      }
      if (!digest) return await skip();
      ts = await deliverCompanyDigest({ ...common, digest, previewFor: previewTarget ? `${recipient.fullName} (company ${cadence})` : undefined });
    } else {
      const digest = digestFor(ctx, recipient.id, period);
      if (!digest) return await skip();
      ts = await deliverDigest({ ...common, digest, previewFor: previewTarget ? `${recipient.fullName} (${cadence})` : undefined });
    }
    posted = true;
    await store.finishSend(key, { status: "sent", slackTs: ts });
    result.sent++;
  } catch (err) {
    if (posted) {
      // The DM went out; leave the row pending → it expires as "interrupted" and is never retried.
      result.sent++;
      log(`[notify] sent but not recorded ${who(key)}: ${errorDetail(err)}`);
    } else if (err instanceof PostOutcomeUnknownError) {
      // Slack may have accepted the DM. Leave the row pending (no finishSend) → the stale sweep
      // marks it "interrupted", which is never retried. Counted failed so the run is flagged.
      result.failed++;
      log(`[notify] post outcome unknown ${who(key)}: ${err.code}`);
    } else {
      result.failed++;
      log(`[notify] send failed ${who(key)}: ${errorDetail(err)}`);
      await store.finishSend(key, { status: "failed", detail: errorDetail(err) }).catch(() => undefined);
    }
  }
}
```

(A `skip()` whose `finishSend` throws falls into the `catch` with `posted === false`, so it is marked failed and retried. This matches today's behaviour for a skipped digest.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/notify && npx tsc --noEmit`

Expected: all PASS, including every existing run-notify test. The established log line `"[notify] claim failed employee=a cadence=daily: db down"` is unchanged. tsc reports no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/notify/context.ts src/lib/notify/context.test.ts src/lib/notify/run-notify.ts src/lib/notify/run-notify.test.ts
git commit -m "feat(notify): send the company report on its recipients' cadences

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Preview subject and test sends for the company report

**Files:**
- Modify: `src/lib/notify/subject.ts`
- Modify: `src/lib/notify/test-send.ts`
- Test: `src/lib/notify/subject.test.ts`, `src/lib/notify/test-send.test.ts`

**Interfaces:**
- Consumes:
  - `companyDigestFor` (Task 4) and `deliverCompanyDigest` (Task 3).
  - `isCompanyDigest` and the widened `isTeamDigest` (Task 2).
- Produces:
  - `TestSubject` gains `{ kind: "company" }`.
  - `previewHref({ kind: "company" }, cadence, key?)` → `/data?tab=notifications&company=1&cadence=…[&at=…]`.
  - `companyTestBanner(adminName: string, cadence: Cadence): string`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/notify/subject.test.ts`, add inside the describe:

```ts
  it("links the company report", () => {
    expect(previewHref({ kind: "company" }, "monthly", "2026-09")).toBe("/data?tab=notifications&company=1&cadence=monthly&at=2026-09");
    expect(previewHref({ kind: "company" }, "weekly")).toBe("/data?tab=notifications&company=1&cadence=weekly");
  });
```

In `src/lib/notify/test-send.test.ts`:
- Change the import to `import { companyTestBanner, sendTest, testBanner, type TestSendDeps } from "./test-send";`.
- Add `const company = { kind: "company" as const };` after `const team = …`.
- In the `it.each` table, change `["an unknown subject kind", { ...ok, subject: { kind: "company" } }]` to `["an unknown subject kind", { ...ok, subject: { kind: "everyone" } }]`.

Then add after the team describe:

```ts
describe("sendTest: the company report", () => {
  it("to me: the report, marked as a test, linked to the Company page", async () => {
    const t = setup();
    const r = await sendTest(t.deps, { subject: company, cadence: "weekly", periodKey: "2026-W39", to: { kind: "me" } });
    expect(r).toEqual({ ok: true, sentTo: "Gareth Admin" });
    expect(t.posts[0].channel).toBe("D-U-gareth");
    expect(first(t.posts[0].blocks)).toContain("🧪 Test: the company weekly report, sent to you by Gareth Admin");
    expect(t.posts[0].text).toContain("Company AI spend · 21–27 Sep 2026");
    expect(JSON.stringify(t.posts[0].blocks.at(-1))).toContain('"url":"https://x.test/explore"');
  });

  it("to any other active employee", async () => {
    const t = setup();
    expect(await sendTest(t.deps, { subject: company, cadence: "weekly", periodKey: "2026-W39", to: { kind: "employee", employeeId: ID.ds } })).toEqual({ ok: true, sentTo: "Sam Lee" });
    expect(t.posts[0].channel).toBe("D-U-sam");
  });

  it("has no subject to send to", async () => {
    const t = setup();
    expect(await sendTest(t.deps, { subject: company, cadence: "weekly", periodKey: "2026-W39", to: { kind: "subject" } })).toMatchObject({ ok: false });
    expect(t.posts).toHaveLength(0);
  });

  it("says so when a daily had no usage, whatever the bill", async () => {
    const t = setup();
    expect(await sendTest(t.deps, { subject: company, cadence: "daily", periodKey: "2026-09-26", to: { kind: "me" } })).toEqual({ ok: false, error: "Nothing to send for that period (no usage)" });
  });

  it("never writes the send log and logs ids only", async () => {
    const t = setup();
    await sendTest(t.deps, { subject: company, cadence: "weekly", periodKey: "2026-W39", to: { kind: "me" } });
    expect(t.calls).toEqual([]);
    expect(t.logs).toContain(`[notify] test send subject=company target=${ID.admin} cadence=weekly`);
  });
});

describe("companyTestBanner", () => {
  it("says it is a test of the company report and who sent it", () => {
    expect(companyTestBanner("Gareth", "monthly")).toBe("🧪 Test: the company monthly report, sent to you by Gareth");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/notify/subject.test.ts src/lib/notify/test-send.test.ts`

Expected: FAIL. `previewHref` produces `team=undefined`, `companyTestBanner` is not a function, and the company subject is rejected as "Invalid input".

- [ ] **Step 3: Implement the subject**

Replace the contents of `src/lib/notify/subject.ts`:

```ts
import type { Cadence } from "./types";

/** Whose numbers a preview or test shows. Client-safe: no server imports. */
export type TestSubject = { kind: "person"; employeeId: string } | { kind: "team"; department: string } | { kind: "company" };
/** Who receives a test: the signed-in admin, the subject themself (people only), or any chosen employee. */
export type TestTarget = { kind: "me" } | { kind: "subject" } | { kind: "employee"; employeeId: string };

/** The Notifications tab's link-driven preview URL (state lives in the URL, not in the client). */
export function previewHref(subject: TestSubject, cadence: Cadence, key?: string | null): string {
  const who =
    subject.kind === "person" ? `preview=${subject.employeeId}`
    : subject.kind === "team" ? `team=${encodeURIComponent(subject.department)}`
    : "company=1";
  return `/data?tab=notifications&${who}&cadence=${cadence}${key ? `&at=${key}` : ""}`;
}
```

- [ ] **Step 4: Implement test sends**

In `src/lib/notify/test-send.ts`:

1. Imports:

```ts
import { companyDigestFor, digestFor, loadNotifyContext, teamDigestFor } from "./context";
import { isCompanyDigest, isTeamDigest } from "./digest";
import { deliverCompanyDigest, deliverDigest, deliverTeamDigest, resolveSlackUser, type RenderChart } from "./deliver";
```

2. In `parseSubject`, before `return null;`:

```ts
  if (v.kind === "company") return { kind: "company" };
```

3. After `testBanner`:

```ts
/** The company report has no subject to send to: every test of it goes to someone, so it names the report. */
export function companyTestBanner(adminName: string, cadence: Cadence): string {
  return `🧪 Test: the company ${cadence} report, sent to you by ${adminName}`;
}
```

4. Replace the team/subject guard:

```ts
  if (subject.kind === "team" && to.kind === "subject") return fail("A team can't receive its own digest: pick yourself or someone else");
  if (subject.kind === "company" && to.kind === "subject") return fail("Pick yourself or someone else to receive the company report");
```

5. Replace the subject-name block:

```ts
    let subjectName: string;
    let subjectId: string | null = null;
    if (subject.kind === "person") {
      const s = ctx.employeesById.get(subject.employeeId);
      if (!s) return fail("Unknown person");
      subjectName = s.fullName;
      subjectId = s.id;
    } else if (subject.kind === "team") {
      if (!activeDepartments(ctx.employees).includes(subject.department)) return fail("Unknown team");
      subjectName = subject.department;
    } else {
      subjectName = "the company";
    }
```

6. Replace the digest build:

```ts
    const digest =
      subject.kind === "person" ? digestFor(ctx, subject.employeeId, period)
      : subject.kind === "team" ? teamDigestFor(ctx, subject.department, period)
      : companyDigestFor(ctx, period);
```

7. Replace the banner, delivery and log lines:

```ts
    const banner =
      subject.kind === "company"
        ? companyTestBanner(adminName, cadence)
        : testBanner({ adminName, subjectName, cadence, toSubject: subjectId !== null && target.id === subjectId });
    const send = { slack: deps.slack, renderChart: deps.renderChart, slackUserId, banner, log: deps.log, sleep: deps.sleep };
    if (isCompanyDigest(digest)) await deliverCompanyDigest({ ...send, digest });
    else if (isTeamDigest(digest)) await deliverTeamDigest({ ...send, digest });
    else await deliverDigest({ ...send, digest });

    const subjectLog = subject.kind === "person" ? `person:${subject.employeeId}` : subject.kind === "team" ? `team:${subject.department}` : "company";
    log(`[notify] test send subject=${subjectLog} target=${target.id} cadence=${cadence}`);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/notify && npx tsc --noEmit`

Expected: all PASS. tsc may now report errors in `src/app/(dashboard)/data/notifications-tab.tsx` and `src/components/notifications/send-test-controls.tsx` where `TestSubject` is narrowed with only two kinds. If so, note them: Task 7 fixes them. Only those two files may error.

- [ ] **Step 6: Commit**

```bash
git add src/lib/notify/subject.ts src/lib/notify/subject.test.ts src/lib/notify/test-send.ts src/lib/notify/test-send.test.ts
git commit -m "feat(notify): preview subject and test sends for the company report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Admin data and server actions for company recipients

**Files:**
- Modify: `src/lib/notify/admin-store.ts`
- Modify: `src/app/(dashboard)/data/notifications-actions.ts`
- Test: `src/lib/notify/admin-store.test.ts`

**Interfaces:**
- Consumes: `ReportKind` (Task 1).
- Produces:
  - `RECIPIENT_TABLE: Record<ReportKind, string>`.
  - `addSubscriptions(…, report?: ReportKind)`, `setSubscription(…, report?)`, `removeSubscriptions(…, report?)`. Each defaults to `"personal"`.
  - `CompanyRecipientRow { employeeId; name; team; cadences; slack; left }`.
  - `SendLogRow.report: ReportKind`.
  - `NotificationsAdminData.companyRecipients: CompanyRecipientRow[]` and `.companyPeople: PersonOption[]`.
  - Server actions: `addCompanyRecipients(employeeIds: string[], cadences: string[])`, `setCompanyRecipientCadence(employeeId: string, cadence: string, enabled: boolean)`, `removeCompanyRecipient(employeeId: string)`.

- [ ] **Step 1: Write the failing test**

In `src/lib/notify/admin-store.test.ts`, change the imports and append:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { addSubscriptions, lastSentLabels, openRate, removeSubscriptions, setSubscription, summariseLastRun } from "./admin-store";
```

```ts
/** Records each query-builder call by table; every query resolves to one written row. */
function fakeSupabase() {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const op of ["upsert", "delete", "eq", "select"]) {
      q[op] = (...args: unknown[]) => {
        calls.push({ table, op, args });
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => void) => resolve({ data: [{ employee_id: "e1" }], error: null });
    return q;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

describe("recipient writes", () => {
  it("company recipients go to their own table; personal ones stay where they were", async () => {
    const s = fakeSupabase();
    expect(await addSubscriptions(s.client, ["e1"], ["weekly"], "admin@x.com", "company")).toBe(1);
    await setSubscription(s.client, "e1", "daily", false, "admin@x.com", "company");
    await removeSubscriptions(s.client, "e1", "company");
    expect(new Set(s.calls.map((c) => c.table))).toEqual(new Set(["notification_company_recipients"]));
    expect(s.calls[0]).toMatchObject({
      op: "upsert",
      args: [[{ employee_id: "e1", cadence: "weekly", created_by: "admin@x.com" }], { onConflict: "employee_id,cadence", ignoreDuplicates: true }],
    });

    const p = fakeSupabase();
    await addSubscriptions(p.client, ["e1"], ["weekly"], "admin@x.com");
    await removeSubscriptions(p.client, "e1");
    expect(new Set(p.calls.map((c) => c.table))).toEqual(new Set(["notification_subscriptions"]));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/notify/admin-store.test.ts`

Expected: FAIL. The company writes hit `notification_subscriptions`.

- [ ] **Step 3: Route recipient writes by report kind**

In `src/lib/notify/admin-store.ts`:

1. Import:

```ts
import { activeDepartments, CADENCES, isActiveEmployee, NOTIFY_EMPLOYEE_COLUMNS, toNotifyEmployee, type Cadence, type ReportKind, type SendMode } from "./types";
```

2. Above `addSubscriptions`:

```ts
/** Each DM's recipients table (person × cadence). */
export const RECIPIENT_TABLE: Record<ReportKind, string> = {
  personal: "notification_subscriptions",
  company: "notification_company_recipients",
};
```

3. Replace the three write functions:

```ts
export async function addSubscriptions(
  supabase: SupabaseClient,
  employeeIds: string[],
  cadences: Cadence[],
  createdBy: string,
  report: ReportKind = "personal",
): Promise<number> {
  const rows = employeeIds.flatMap((employee_id) => cadences.map((cadence) => ({ employee_id, cadence, created_by: createdBy })));
  const { data, error } = await supabase
    .from(RECIPIENT_TABLE[report])
    .upsert(rows, { onConflict: "employee_id,cadence", ignoreDuplicates: true })
    .select("employee_id");
  if (error) throw new Error(`addSubscriptions: ${error.message}`);
  return data?.length ?? 0;
}

export async function setSubscription(
  supabase: SupabaseClient,
  employeeId: string,
  cadence: Cadence,
  enabled: boolean,
  createdBy: string,
  report: ReportKind = "personal",
): Promise<void> {
  if (enabled) {
    await addSubscriptions(supabase, [employeeId], [cadence], createdBy, report);
    return;
  }
  const { error } = await supabase.from(RECIPIENT_TABLE[report]).delete().eq("employee_id", employeeId).eq("cadence", cadence);
  if (error) throw new Error(`setSubscription: ${error.message}`);
}

export async function removeSubscriptions(supabase: SupabaseClient, employeeId: string, report: ReportKind = "personal"): Promise<void> {
  const { error } = await supabase.from(RECIPIENT_TABLE[report]).delete().eq("employee_id", employeeId);
  if (error) throw new Error(`removeSubscriptions: ${error.message}`);
}
```

- [ ] **Step 4: Load company recipients and the report kind for the admin tab**

In `src/lib/notify/admin-store.ts`:

1. Add after `RecipientRow`:

```ts
/** A company report recipient: the cadences they get it on. */
export interface CompanyRecipientRow {
  employeeId: string;
  name: string;
  team: string | null;
  cadences: Cadence[];
  slack: RecipientRow["slack"];
  left: boolean;
}
```

2. Change `SendLogRow`:

```ts
export interface SendLogRow { at: string; name: string; report: ReportKind; cadence: string; periodKey: string; mode: string; status: string; detail: string | null; openedAt: string | null }
```

3. In `NotificationsAdminData`, add after `recipients`:

```ts
  companyRecipients: CompanyRecipientRow[];
  companyPeople: PersonOption[]; // active, not on the company list yet: its add-a-person picker
```

4. In `loadLastSent`, count personal sends only by adding `.eq("report", "personal")` after `.eq("status", "sent")`. Update its doc comment:

```ts
/** Paginated (gotcha #1): one recipient can have many rows, so a bounded newest-N read could miss someone. Personal sends only: the company report has its own list. */
```

5. In `loadNotificationsAdmin`:

```ts
  const companyP = pageAll<{ employee_id: string; cadence: Cadence }>(
    (a, b) => supabase.from(RECIPIENT_TABLE.company).select("employee_id, cadence").order("employee_id").order("cadence").range(a, b),
    RECIPIENT_TABLE.company,
  );
```

Add `companyRows` to the `Promise.all` destructuring and list, after `subs`:

```ts
  const [subs, companyRows, lastSent, empRows, slackRows, sendRes, fixedCosts, recentSent] = await Promise.all([
    subsP,
    companyP,
    subsP.then((rows) => loadLastSent(supabase, [...new Set(rows.map((r) => r.employee_id))])),
```

Change the send-log select to include `report`:

```ts
    supabase.from("notification_sends").select("employee_id, cadence, period_key, mode, report, status, detail, updated_at, opened_at").order("updated_at", { ascending: false }).order("id").limit(200),
```

and its cast:

```ts
  const sends = (sendRes.data ?? []) as (SendRowLite & { period_key: string; detail: string | null; report: ReportKind })[];
```

Replace the `cadencesBy` loop with a helper used by both lists, plus a Slack-status helper:

```ts
  const byPerson = (rows: { employee_id: string; cadence: Cadence }[]) => {
    const m = new Map<string, Cadence[]>();
    for (const r of rows) m.set(r.employee_id, [...(m.get(r.employee_id) ?? []), r.cadence]);
    return m;
  };
  const cadencesBy = byPerson(subs);
  const companyBy = byPerson(companyRows);
  const slackStatus = (id: string): RecipientRow["slack"] => (!slack.has(id) ? "unknown" : slack.get(id) ? "found" : "not_found");
```

In the `recipients` map, use `slack: slackStatus(id),`.

After `recipients`:

```ts
  const companyRecipients: CompanyRecipientRow[] = [...companyBy].map(([id, cadences]): CompanyRecipientRow => {
    const e = byId.get(id);
    return { employeeId: id, name: e?.fullName ?? "Unknown", team: e?.department ?? null, cadences, slack: slackStatus(id), left: e ? !isActiveEmployee(e) : true };
  }).sort((a, b) => a.name.localeCompare(b.name));
```

In the returned object, add `companyRecipients` and `companyPeople`, and the report on each send row:

```ts
    recipients,
    companyRecipients,
    sends: sends.slice(0, 50).map((s) => ({
      at: s.updated_at, name: byId.get(s.employee_id)?.fullName ?? "Unknown", report: s.report, cadence: s.cadence,
      periodKey: s.period_key, mode: s.mode, status: s.status, detail: s.detail, openedAt: s.opened_at,
    })),
```

```ts
    people: activePeople.filter((p) => !cadencesBy.has(p.id)),
    companyPeople: activePeople.filter((p) => !companyBy.has(p.id)),
```

- [ ] **Step 5: Add the server actions**

In `src/app/(dashboard)/data/notifications-actions.ts`, add a shared validator after `cadencesOrThrow`:

```ts
function idsOrThrow(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_BATCH || !input.every(isUuid)) throw new Error("Invalid people selection");
  return input;
}
```

Use it in `addRecipients` (replace its inline check):

```ts
export async function addRecipients(employeeIds: string[], cadences: string[]): Promise<{ added: number }> {
  await requireAdmin();
  const added = await addSubscriptions(getSupabaseAdminClient(), idsOrThrow(employeeIds), cadencesOrThrow(cadences), await actorEmail());
  revalidatePath("/data");
  return { added };
}
```

After `removeRecipient`, add:

```ts
/** Adds people to the company report on these cadences (the report is its own DM, apart from personal digests). */
export async function addCompanyRecipients(employeeIds: string[], cadences: string[]): Promise<{ added: number }> {
  await requireAdmin();
  const added = await addSubscriptions(getSupabaseAdminClient(), idsOrThrow(employeeIds), cadencesOrThrow(cadences), await actorEmail(), "company");
  revalidatePath("/data");
  return { added };
}

export async function setCompanyRecipientCadence(employeeId: string, cadence: string, enabled: boolean): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId) || !isCadence(cadence) || typeof enabled !== "boolean") throw new Error("Invalid input");
  await setSubscription(getSupabaseAdminClient(), employeeId, cadence, enabled, await actorEmail(), "company");
  revalidatePath("/data");
}

export async function removeCompanyRecipient(employeeId: string): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId)) throw new Error("Invalid input");
  await removeSubscriptions(getSupabaseAdminClient(), employeeId, "company");
  revalidatePath("/data");
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/notify && npx eslint src/lib/notify src/app/\(dashboard\)/data/notifications-actions.ts`

Expected: all PASS, and lint is clean. (tsc may still flag the two UI files from Task 5, plus `notifications-tab.tsx` for the new `SendLogRow.report`. Task 7 fixes those.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/notify/admin-store.ts src/lib/notify/admin-store.test.ts "src/app/(dashboard)/data/notifications-actions.ts"
git commit -m "feat(notify): admin data and actions for company report recipients

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Notifications tab: company recipients panel, preview and send log

**Files:**
- Create: `src/components/notifications/company-recipients.tsx`
- Modify: `src/components/notifications/recipients-table.tsx` (export the cadence and Slack labels)
- Modify: `src/components/notifications/preview-picker.tsx`
- Modify: `src/components/notifications/send-test-controls.tsx`
- Modify: `src/app/(dashboard)/data/notifications-tab.tsx`
- Modify: `src/app/(dashboard)/data/page.tsx`

**Interfaces:**
- Consumes:
  - `CompanyRecipientRow`, `companyRecipients`, `companyPeople`, `SendLogRow.report` and the three company actions (Task 6).
  - `TestSubject` `{ kind: "company" }` and `previewHref` (Task 5).
  - `companyDigestFor` (Task 4).
  - `chartLayoutsForCompany` and `renderCompanyDigest` (Task 3).
  - `isCompanyDigest` (Task 2).
- Produces: a `?company=1` preview route parameter on `/data?tab=notifications`.

There are no unit tests for these components: the repo's UI isn't unit-tested. Verify with lint, tsc and the build here; the visual check runs after the migration is applied (see "After the plan").

- [ ] **Step 1: Share the labels**

In `src/components/notifications/recipients-table.tsx`, export the two constants (rename them and update their uses in that file):

```ts
export const CADENCE_LABEL: Record<Cadence, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
export const SLACK_STATUS: Record<RecipientRow["slack"], { text: string; cls: string }> = {
  found: { text: "✓", cls: "text-emerald-400" },
  not_found: { text: "✗ not found", cls: "text-pink-400" },
  unknown: { text: "not looked up", cls: "text-muted" },
};
```

Replace `LABEL[` → `CADENCE_LABEL[` and `SLACK[` → `SLACK_STATUS[` throughout that file.

- [ ] **Step 2: Create the company recipients panel**

Create `src/components/notifications/company-recipients.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { addCompanyRecipients, removeCompanyRecipient, setCompanyRecipientCadence } from "@/app/(dashboard)/data/notifications-actions";
import type { CompanyRecipientRow, PersonOption } from "@/lib/notify/admin-store";
import { previewHref } from "@/lib/notify/subject";
import { CADENCES, type Cadence } from "@/lib/notify/types";
import { CADENCE_LABEL, SLACK_STATUS } from "./recipients-table";

/** Who gets the whole-company report, and on which cadences. Checkboxes save as you click. */
export function CompanyRecipients({ rows, people }: { rows: CompanyRecipientRow[]; people: PersonOption[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const [defaults, setDefaults] = useState<Cadence[]>(["weekly", "monthly"]);
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
        <datalist id="notify-company-people">{people.map((p) => <option key={p.id} value={p.label} />)}</datalist>
        <input
          list="notify-company-people" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Add a person…"
          aria-label="Add a company report recipient"
          className="w-56 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
        />
        <button
          disabled={pending || !idByLabel.has(person) || defaults.length === 0}
          onClick={() => run(async () => { await addCompanyRecipients([idByLabel.get(person)!], defaults); setPerson(""); })}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40"
        >Add</button>
        <span className="ml-2 text-muted">They get:</span>
        {CADENCES.map((c) => (
          <label key={c} className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={defaults.includes(c)} onChange={(e) => setDefaults((d) => (e.target.checked ? [...d, c] : d.filter((x) => x !== c)))} />
            {CADENCE_LABEL[c]}
          </label>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody gets the company report yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Person</th>
                {CADENCES.map((c) => <th key={c} className="px-2 py-2 text-center font-medium">{CADENCE_LABEL[c]}</th>)}
                <th className="px-3 py-2 font-medium">Slack</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2">
                    <span className="font-medium">{r.name}</span>
                    {r.left && <span className="ml-2 rounded bg-pink-500/15 px-1.5 text-[10px] text-pink-300">left</span>}
                    <div className="text-xs text-muted">{r.team ?? "No team"}</div>
                  </td>
                  {CADENCES.map((c) => (
                    <td key={c} className="px-2 py-2 text-center">
                      <input
                        type="checkbox" disabled={pending} checked={r.cadences.includes(c)}
                        onChange={(e) => run(() => setCompanyRecipientCadence(r.employeeId, c, e.target.checked))}
                        aria-label={`Company report ${CADENCE_LABEL[c].toLowerCase()} for ${r.name}`}
                      />
                    </td>
                  ))}
                  <td className={`px-3 py-2 text-xs ${SLACK_STATUS[r.slack].cls}`}>{SLACK_STATUS[r.slack].text}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-xs">
                    <Link href={previewHref({ kind: "company" }, r.cadences[0] ?? "weekly")} className="mr-3 text-accent">Preview</Link>
                    <button disabled={pending} onClick={() => run(() => removeCompanyRecipient(r.employeeId))} className="text-muted hover:text-pink-300">Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add "Company" to the preview picker**

In `src/components/notifications/preview-picker.tsx`, after the team `<select>` and before the loading indicator:

```tsx
      <span className="text-muted">or</span>
      <button
        type="button" onClick={() => go({ kind: "company" })} aria-pressed={current?.kind === "company"}
        className={`rounded-md border px-2 py-1 ${current?.kind === "company" ? "border-accent bg-accent/15 text-accent" : "border-border bg-surface-2 text-foreground"}`}
      >Company report</button>
```

Update the component doc's first line to: `Preview any active person, any Okta team, or the company report.`

- [ ] **Step 4: Name the company report in the test-send confirmation**

In `src/components/notifications/send-test-controls.tsx`, replace the confirm line:

```ts
    const what = subject.kind === "company" ? `the company ${cadence} report` : `${subjectName}'s ${cadence} digest`;
    if (thirdParty && !window.confirm(`Send ${what} to ${otherPerson?.name}?`)) return;
```

(`radio("subject", "This person")` is already person-only.)

- [ ] **Step 5: Pass the `company` parameter through the page**

In `src/app/(dashboard)/data/page.tsx`, add `company?: string` to the `searchParams` type. Pass it:

```tsx
      {active.key === "notifications" && <NotificationsTab params={{ preview: sp.preview, team: sp.team, company: sp.company, cadence: sp.cadence, at: sp.at }} />}
```

- [ ] **Step 6: Preview the company report, show its panel and the report kind in the log**

In `src/app/(dashboard)/data/notifications-tab.tsx`:

1. Imports. Add or replace these lines:

```ts
import { CompanyRecipients } from "@/components/notifications/company-recipients";
import { companyDigestFor, digestFor, loadNotifyContext, teamDigestFor } from "@/lib/notify/context";
import { chartLayoutsFor, chartLayoutsForCompany, chartLayoutsForTeam } from "@/lib/notify/deliver";
import { isCompanyDigest, isTeamDigest } from "@/lib/notify/digest";
import { renderCompanyDigest, renderDigest, renderTeamDigest, type SlackBlock } from "@/lib/notify/render";
```

2. Params and state:

```ts
export interface NotificationsParams { preview?: string; team?: string; company?: string; cadence?: string; at?: string }
```

In `PreviewState`, change the comments and `fixedCosts`:

```ts
  name: string; // the person's name, the department, or "Company report"
  subjectActive: boolean; // false for a leaver (or an unknown person): they can't be sent a test themself
  ...
  fixedCosts: FixedCostChoice | null; // which setting the digest was built with, and why; null = the company report (its own section)
```

3. In `loadPreview`, replace the opening guard and the subject selection:

```ts
/** A person (?preview=<uuid>), a team (?team=<department>, ignored unless it is a real department) or the company report (?company=1). */
async function loadPreview(p: NotificationsParams): Promise<PreviewState | null> {
  const personId = isUuid(p.preview) ? p.preview : null;
  const wantsCompany = p.company === "1";
  if (!personId && !p.team && !wantsCompany) return null;
```

```ts
  let subject: TestSubject;
  if (personId) subject = { kind: "person", employeeId: personId };
  else if (p.team && activeDepartments(ctx.employees).includes(p.team)) subject = { kind: "team", department: p.team };
  else if (wantsCompany) subject = { kind: "company" };
  else return null;

  const digest =
    subject.kind === "person" ? digestFor(ctx, subject.employeeId, period)
    : subject.kind === "team" ? teamDigestFor(ctx, subject.department, period)
    : companyDigestFor(ctx, period);
  const person = subject.kind === "person" ? ctx.employeesById.get(subject.employeeId) : undefined;
  const base = {
    subject, cadence, key, label: period.label,
    name: subject.kind === "person" ? (person?.fullName ?? "Unknown") : subject.kind === "team" ? subject.department : "Company report",
    subjectActive: subject.kind !== "person" || (person !== undefined && isActiveEmployee(person)),
    fixedCosts:
      subject.kind === "person" ? fixedCostsFor(ctx.fixedCosts, { id: subject.employeeId, department: person?.department ?? null })
      : subject.kind === "team" ? fixedCostsForTeam(ctx.fixedCosts, subject.department)
      : null,
    prevKey: stepKey(cadence, key, -1, now), nextKey: stepKey(cadence, key, 1, now),
  };
  if (!digest) return { ...base, blocks: null, images: {} };
  const layouts: Record<string, ChartLayout | undefined> = isCompanyDigest(digest)
    ? chartLayoutsForCompany(digest)
    : isTeamDigest(digest) ? chartLayoutsForTeam(digest) : chartLayoutsFor(digest);
```

…and the final return:

```ts
  const rendered = isCompanyDigest(digest)
    ? renderCompanyDigest(digest, files)
    : isTeamDigest(digest) ? renderTeamDigest(digest, files) : renderDigest(digest, files);
  return { ...base, blocks: rendered.blocks, images };
```

4. In `NotificationsTab`, extend `current` and `previewKey`:

```ts
  const current: TestSubject | null =
    preview && !("error" in preview) ? preview.subject
    : isUuid(params.preview) ? { kind: "person", employeeId: params.preview }
    : params.team && data.departments.includes(params.team) ? { kind: "team", department: params.team }
    : params.company === "1" ? { kind: "company" }
    : null;
  const cadence: Cadence = isCadence(params.cadence) ? params.cadence : "weekly";
  const previewKey = !current ? "none" : current.kind === "person" ? current.employeeId : current.kind === "team" ? `team:${current.department}` : "company";
```

5. In the left panel, after the Fixed costs block's closing `</div>`, add:

```tsx
          <div className="mt-6 border-t border-border pt-4">
            <h2 className="mb-1 text-sm font-medium">Company report · {data.companyRecipients.length}</h2>
            <p className="mb-3 text-xs text-muted">
              A separate Slack message with the whole company&apos;s AI spend: usage by team and person, then seats &amp; subscriptions.
              Same schedule as personal digests; someone on both lists gets both.
            </p>
            <CompanyRecipients rows={data.companyRecipients} people={data.companyPeople} />
          </div>
```

6. The preview prompt, explanation, fixed-costs note and empty message:

```tsx
            <p className="text-sm text-muted">Pick a person, a team or the company report above, or click Preview on a recipient, to see exactly what they&apos;d get.</p>
```

```tsx
                <span className="ml-2">
                  {preview.subject.kind === "team"
                    ? "Built from live data. Team digests are for previews and tests only; they are never scheduled."
                    : preview.subject.kind === "company"
                      ? "Built from live data, exactly as the cron would send it to every company report recipient."
                      : "Built from live data, exactly as the cron would send it."}
                </span>
```

```tsx
              <p className="mb-3 text-xs text-muted">
                {preview.fixedCosts ? (
                  <>
                    Seats &amp; subscriptions: <span className="text-foreground">{preview.fixedCosts.include ? "included" : "excluded"}</span>{" "}
                    ({FIXED_SOURCE[preview.fixedCosts.source]})
                  </>
                ) : (
                  <>Seats &amp; subscriptions: <span className="text-foreground">their own section</span> (the company report always shows them apart from usage)</>
                )}
              </p>
```

```tsx
                <p className="text-sm text-muted">
                  Nothing to send for this period: no usage by {preview.subject.kind === "team" ? "this team" : preview.subject.kind === "company" ? "anyone in the company" : "them or their reports"}.
                </p>
```

7. Recent sends: add a Report column after Person:

```tsx
                  {["When", "Person", "Report", "Cadence", "Period", "Mode", "Status", "Opened", "Detail"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
```

```tsx
                    <td className="px-3 py-2">{s.name}</td>
                    <td className="px-3 py-2 text-xs">{s.report === "company" ? "Company" : "Personal"}</td>
```

8. In the Recent sends caption, make the open rate cover both kinds explicitly. Change "live digests" to "live messages (personal and company)" in the `{data.opens.opened} of {data.opens.sent} …` text:

```tsx
            {data.opens.sent === 0 ? "no live digests yet" : `${data.opens.opened} of ${data.opens.sent} live messages, personal and company (${Math.round((data.opens.opened / data.opens.sent) * 100)}%)`}
```

- [ ] **Step 7: Lint, types and build**

Run: `npm run lint && npx tsc --noEmit && CI=true npm run build`

Expected: lint clean, no type errors, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/components/notifications "src/app/(dashboard)/data/notifications-tab.tsx" "src/app/(dashboard)/data/page.tsx"
git commit -m "feat(notify): company report recipients, preview and send log on Data → Notifications

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Docs and full verification

**Files:**
- Modify: `src/lib/changelog.ts` (new entry first in `CHANGELOG`)
- Modify: `CLAUDE.md` (the **Slack digests** bullet)
- Modify: `src/app/api/digest/open/[id]/route.ts` (doc comment)

- [ ] **Step 1: Changelog entry**

In `src/lib/changelog.ts`, insert as the first element of `CHANGELOG`:

```ts
  {
    date: "2026-10-09",
    title: "A company-wide AI spend report in Slack",
    items: [
      "Admins can now pick people to receive a company AI spend report in Slack, daily, weekly or monthly, under Data → Notifications. It's its own message, separate from anyone's personal summary, and arrives at the same time.",
      "It shows the company's AI usage with a chart, the teams and people spending the most, and the company's seats and subscriptions bill compared with last month. The monthly report ends with the month's total, matching the dashboard's Company page.",
    ],
  },
```

- [ ] **Step 2: CLAUDE.md**

In the **Slack digests** bullet, insert this sentence immediately before ``"`?date=` replays are preview-only."``:

```
**Company report** (spec `2026-10-09-company-report-design.md`): a separate DM to the people on `notification_company_recipients` (migration 0019, applied before deploy), on the same schedule — company-wide usage (chart, top teams by Explore's `rankTeams` grouping with "unattributed" apart, top people with "not tied to a person" apart) plus a text-only seats & subscriptions section (daily/weekly as a share of the monthly bill, compared month on month; monthly as posted); it ignores the fixed-costs setting, and a monthly's total equals Explore's company total. `notification_sends.report` (`personal`|`company`) is part of the claim key — every `SendKey` carries it, so a person's two DMs never block each other. Built once per period per run (`run-notify.ts`); its open link lands on `/explore`.
```

- [ ] **Step 3: The open route's doc comment**

In `src/app/api/digest/open/[id]/route.ts`, change the comment's first sentence to:

```ts
/**
 * A Slack digest's "Open in dashboard" button: stamp the send's first open, then
 * redirect to the recipient's Explore page (the Company page for the company report).
```

(Keep the rest of the comment.)

- [ ] **Step 4: Full verification**

Run: `npm run test && npm run lint && CI=true npm run build`

Expected: every test passes, lint is clean, and the build succeeds. Report any failure by name.

- [ ] **Step 5: Commit**

```bash
git add src/lib/changelog.ts CLAUDE.md "src/app/api/digest/open/[id]/route.ts"
git commit -m "docs: company report in the changelog and CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the plan (only with the user's go-ahead)

1. **Whole-branch review:** dispatch a reviewer on `main..company-report`. Fix Critical and Important findings.
2. **Apply migration 0019 to production** (Supabase project `iiekcgotwyoalggaxvpy`, via `apply_migration`). Verify the following:
   - The table exists.
   - `notification_sends.report` exists with default `personal`.
   - The unique constraint is `(employee_id, cadence, period_key, mode, report)`.
3. **Visual check:** on Data → Notifications (local `npm run dev` against production data), check the following:
   - The Company report panel adds and removes a person.
   - The "Company report" preview renders for daily, weekly and monthly, including the monthly total line.
   - The Recent sends Report column shows each send's kind.
4. **Merge and deploy:**
   - Run `git checkout main && git merge --no-ff company-report -m "Merge branch 'company-report': whole-company AI spend report in Slack"`.
   - Push with `GH_TOKEN="$(gh auth token -u wt-ihq)" git push origin main`.
   - Watch the deploy with `vercel ls ai-costs --scope jml-ihq`.
