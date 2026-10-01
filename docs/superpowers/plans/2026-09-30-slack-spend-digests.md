# Slack Spend Digests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send pilot recipients daily/weekly/monthly Slack DMs of their own AI spend and, for managers, their Okta reporting tree's spend, each section with its own chart. Admins manage the pilot on a new Data → Notifications tab.

**Architecture:** Pure, unit-tested modules under `src/lib/notify/`: reporting tree, schedule, freshness/caveats, digest builder, chart layout, Block Kit renderer. Around them, an injectable Slack client and an injectable `NotifyStore` (Supabase implementation plus an in-memory one for tests). A `runNotify` orchestrator is driven by a new daily cron route (`/api/cron/notify`, 07:00 UTC). The admin tab and the cron share the same `digestFor` → `renderDigest` path, so the preview can't drift from what's sent.

**Tech Stack:** Next.js 16 App Router, TypeScript 5.9, Supabase (PostgREST), vitest 4, `next/og` (`ImageResponse`/Satori) for chart PNGs, Slack Web API over `fetch`. **No new npm dependencies.**

**Spec:** `docs/superpowers/specs/2026-09-30-slack-spend-digests-design.md`

## Global Constraints

- All sync/period windows are UTC and **exclusive-end** `[from, toExclusive)`.
- Every `"use server"` export starts with `await requireAdmin()` (`src/lib/auth-guard.ts`); actions are public POST endpoints.
- Cron routes gate through `isCronAuthorized` (`src/lib/cron-auth.ts`), which fails closed.
- Reads of growing tables (`notification_subscriptions`, `slack_users`, `sync_runs`, `employees`) paginate with `.order(...).range(from, from+999)` and a unique tiebreaker (gotcha #1). The only exception is `notification_sends`, read as a bounded newest-first `.limit(200)`.
- `SLACK_BOT_TOKEN` is read **only** in `src/lib/notify/wiring.ts` (`import "server-only"`). `slack-client.ts` takes the token as a parameter, so it stays unit-testable (`server-only` doesn't resolve under vitest).
- Logs and `notification_sends.detail` never contain names or amounts. Use employee IDs, counts and Slack error codes.
- **Daily/weekly headline basis = usage = facts where `!isMonthlyLevelFact(f)`** (`src/lib/explore/shape.ts`). That excludes seats, subscriptions *and* Claude Team's monthly usage lump. **Monthly basis = total = every fact.** The monthly total must equal Explore's person month view to the cent.
- Tool labels and colours come from `dimLabel("vendor", key)` / `dimColorFor("vendor", key, toolColors)`, with keys from `vendorKeyOf`. Amounts go through `formatUsd`.
- Period labels come from `src/lib/explore/period.ts` (`"29 Sep 2026"`, `"21–27 Sep 2026"`, `"September 2026"`), the same as the dashboard.
- **Migration `0015` must be applied to production BEFORE any deploy containing the Task 1 normalizer change.** Otherwise the nightly Okta upsert fails on the unknown `manager_ref` column and the identity sync breaks.
- Don't touch `src/lib/queries/cached.ts`. No `*Cached` shape changes, so no `CACHE_VERSION` bump and no `FACTS_TAG` busting (none of the new tables feed cached reads).
- Before every commit: `npm run test`, `npm run lint`, `CI=true npm run build`.
- Commit messages are conventional (`feat:` / `fix:` / `docs:` / `test:`) and end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Work on branch `slack-digests`. **Never push, merge or deploy unless Gareth asks.** Production DB changes need his explicit per-action go-ahead.

## Review Focus

1. **Names with `&`, `<`, `>`** (e.g. "Tom & Jerry") must show literally in Slack and must not break mrkdwn or `<url|name>` links. Tests: Task 7 (`escapeMrkdwn`, `parseMrkdwn` entity decoding).
2. **Claude Team's monthly usage lump** (an `overage` fact stamped on the 1st) must not inflate daily/weekly headlines or charts, and must not trigger a "data may be incomplete" caveat for the whole month. Tests: Task 5 (digest excludes it), Task 4 (freshness skips monthly-snapshot sources).
3. **A DB write failing *after* a successful Slack post must not cause a resend.** The DM has gone, so the row must never become retryable. Test: Task 10.
4. **A recipient with no facts at all** (a new joiner) must get a valid $0 weekly/monthly digest, and `projectPeriodEnd` must not be called on an empty array (it reads `facts[0]`). Test: Task 5.
5. **`?date=` replays in `live` mode must be refused.** They could DM real people about old periods. Test: Task 3 (`resolveRunDate`).

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/0015_slack_notifications.sql` | `employees.manager_ref` / `employee_number`, 3 new tables |
| `src/lib/ingest/normalizers/okta.ts` (+ fixture/test) | capture `managerId` / `employeeNumber` |
| `src/lib/notify/types.ts` | shared types, env mode, input guards, employee row mapping |
| `src/lib/notify/tree.ts` | reporting tree from `manager_ref` |
| `src/lib/notify/schedule.ts` | digest periods, due cadences, replay-date guard |
| `src/lib/notify/freshness.ts` | per-source freshness, monthly readiness, caveats |
| `src/lib/notify/digest.ts` | the `Digest` builder (all numbers) |
| `src/lib/notify/chart.ts` | chart layout (pure geometry) |
| `src/lib/notify/chart-image.tsx` | layout → PNG via `next/og` |
| `src/lib/notify/render.ts` | `Digest` → Block Kit + text fallback |
| `src/lib/notify/mrkdwn.ts` | mrkdwn subset parser (admin preview) |
| `src/lib/notify/slack-client.ts` | Slack Web API client (injected token + fetch) |
| `src/lib/notify/store.ts` | `NotifyStore` interface + Supabase implementation |
| `src/lib/notify/memory-store.ts` | in-memory `NotifyStore` for tests |
| `src/lib/notify/context.ts` | load everything once; `digestFor` |
| `src/lib/notify/deliver.ts` | Slack user resolution, chart upload, post with fallback |
| `src/lib/notify/run-notify.ts` | the cron orchestrator |
| `src/lib/notify/wiring.ts` | env → Slack client / base URL (`server-only`) |
| `src/app/api/cron/notify/route.ts` | cron endpoint |
| `src/lib/notify/admin-store.ts` | admin tab reads and subscription writes |
| `src/app/(dashboard)/data/notifications-actions.ts` | server actions |
| `src/app/(dashboard)/data/notifications-tab.tsx` | the tab (server component) |
| `src/components/notifications/*.tsx` | recipients table, preview renderer, send-to-me button |
| `docs/slack-app-manifest.yml`, `scripts/slack-smoke.ts` | Slack app setup and the image check |

---

### Task 1: Migration and Okta manager fields

**Files:**
- Create: `supabase/migrations/0015_slack_notifications.sql`
- Modify: `src/lib/ingest/normalizers/okta.ts`
- Modify: `src/lib/ingest/fixtures/okta.ts`
- Test: `src/lib/ingest/normalizers/okta.test.ts`

**Interfaces:**
- Produces: DB columns `employees.manager_ref text`, `employees.employee_number text`; tables `notification_subscriptions`, `notification_sends`, `slack_users` (columns exactly as in the SQL below); `EmployeeUpsert.manager_ref: string | null`, `EmployeeUpsert.employee_number: string | null`.

- [x] **Step 1: Write the failing test.** Add to the `describe("normalizeOkta")` block in `src/lib/ingest/normalizers/okta.test.ts`:

```ts
  it("captures the raw Okta managerId and employeeNumber (reporting tree inputs)", () => {
    const rows = normalizeOkta(oktaUsersFixture);
    const tom = rows.find((r) => r.email === "tom.reeve@intenthq.com")!;
    const gareth = rows.find((r) => r.email === "gareth.jones@intenthq.com")!;
    expect(tom.manager_ref).toBe("00u1");
    expect(gareth.manager_ref).toBeNull(); // no managerId → null, never ""
    expect(gareth.employee_number).toBe("1001");
    expect(tom.employee_number).toBeNull();
  });
```

And in `src/lib/ingest/fixtures/okta.ts`, give Gareth an `employeeNumber` and Tom a `managerId` (append the keys inside the existing `profile` objects):

```ts
      profile: { firstName: "Gareth", lastName: "Jones", email: "Gareth.Jones@intenthq.com", login: "gareth.jones@intenthq.com", department: "Engineering", employeeNumber: "1001" },
```
```ts
      profile: { displayName: "Tom Reeve", email: "tom.reeve@intenthq.com", login: "tom.reeve@intenthq.com", department: "Product", managerId: " 00u1 " },
```

(The surrounding spaces in `" 00u1 "` are deliberate: the normalizer must trim.)

- [x] **Step 2: Run the test and check it fails**

Run: `npx vitest run src/lib/ingest/normalizers/okta.test.ts`
Expected: FAIL. `manager_ref` is `undefined`, and TS complains the fixture keys aren't on the profile type.

- [x] **Step 3: Implement.** In `src/lib/ingest/normalizers/okta.ts`:

Add to the `profile` type in `OktaUser` (after `department?: string;`):
```ts
    managerId?: string;
    employeeNumber?: string;
```
Add to `EmployeeUpsert` (after `leave_date`):
```ts
  /** Raw Okta profile.managerId — resolved to a manager at read time (src/lib/notify/tree.ts). */
  manager_ref: string | null;
  /** Okta profile.employeeNumber — a possible target of another user's managerId. */
  employee_number: string | null;
```
Add to the object pushed in `normalizeOkta` (after `leave_date: ...`):
```ts
      manager_ref: p.managerId?.toString().trim() || null,
      employee_number: p.employeeNumber?.toString().trim() || null,
```

Create `supabase/migrations/0015_slack_notifications.sql`:
```sql
-- Slack spend digests (docs/superpowers/specs/2026-09-30-slack-spend-digests-design.md).
--
-- Reporting tree inputs: Okta's raw profile.managerId, stored as-is and
-- resolved at read time against okta_id / email / employee_number (whichever
-- the tenant uses) — never a stored manager FK that could go stale.
alter table employees add column if not exists manager_ref text;
alter table employees add column if not exists employee_number text;
comment on column employees.manager_ref is 'Raw Okta profile.managerId; resolved at read time (src/lib/notify/tree.ts).';
comment on column employees.employee_number is 'Okta profile.employeeNumber; a possible target of manager_ref.';

-- The pilot allowlist: no row, no message. One row per cadence.
create table notification_subscriptions (
  employee_id uuid not null references employees(id) on delete cascade,
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (employee_id, cadence)
);

-- Send log + idempotency guard. A row is claimed (pending) BEFORE any Slack
-- call; the unique key makes a re-run skip anything already handled. `mode`
-- is in the key so preview runs never count as live sends.
create table notification_sends (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly')),
  period_key  text not null,
  mode        text not null check (mode in ('preview', 'live')),
  status      text not null check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts    integer not null default 1,
  slack_ts    text,
  detail      text, -- skip/failure reason; never names or amounts
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (employee_id, cadence, period_key, mode)
);
create index notification_sends_updated_at_idx on notification_sends (updated_at desc);
create index notification_sends_pending_idx on notification_sends (updated_at) where status = 'pending';

-- users.lookupByEmail cache. slack_user_id null = looked up, not found.
-- Separate from employees so the nightly Okta upsert never touches it.
create table slack_users (
  employee_id   uuid primary key references employees(id) on delete cascade,
  slack_user_id text,
  looked_up_at  timestamptz not null default now()
);

alter table notification_subscriptions enable row level security;
grant all on public.notification_subscriptions to service_role;
alter table notification_sends enable row level security;
grant all on public.notification_sends to service_role;
alter table slack_users enable row level security;
grant all on public.slack_users to service_role;
```

- [x] **Step 4: Run the tests and check they pass**

Run: `npx vitest run src/lib/ingest/normalizers/okta.test.ts`
Expected: PASS (all existing tests plus the new one).

- [x] **Step 5: Apply the migration to the LOCAL database** (if the local Supabase stack is running: `supabase status`). Run `supabase migration up`. Expected: `0015_slack_notifications.sql` applies without error. If the local stack isn't running, note that in the task report and move on. **Don't touch production.**

- [x] **Step 6: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
```bash
git add supabase/migrations/0015_slack_notifications.sql src/lib/ingest/normalizers/okta.ts src/lib/ingest/fixtures/okta.ts src/lib/ingest/normalizers/okta.test.ts
git commit -m "feat: store Okta managerId + notification tables (migration 0015)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### ⏸ Checkpoint A: Okta manager audit (Gareth; runs alongside Tasks 2–8)

Needs Gareth's explicit go-ahead at each step. Don't wait for this before starting Task 2: the tree resolves every key format, so later tasks don't depend on the result.

1. Apply `0015_slack_notifications.sql` to **production** (Supabase SQL editor, or Supabase MCP `apply_migration`, project `iiekcgotwyoalggaxvpy`).
2. Only after step 1: ship **only** Task 1's commit to production (e.g. cherry-pick it onto a branch off `main`, merge, push, following the deploy memory: push as `wt-ihq`).
3. Wait for the 06:00 UTC sync, or trigger `GET /api/cron/sync?source=okta` with the CRON_SECRET bearer.
4. Run this **aggregates-only** audit (SQL editor or MCP `execute_sql`):

```sql
with active as (
  select * from employees
  where leave_date is null and coalesce(lower(employment_status), '') not in ('deprovisioned', 'suspended', 'leaver')
), keys as (
  select lower(okta_id) as k from employees where okta_id is not null
  union select lower(email) from employees
  union select lower(employee_number) from employees where employee_number is not null
)
select
  count(*)                                                        as active,
  count(*) filter (where manager_ref is not null)                 as with_manager_ref,
  count(*) filter (where lower(trim(manager_ref)) in (select k from keys)) as resolvable,
  count(*) filter (where manager_ref ~* '^[^@\s]+@[^@\s]+$')      as ref_email_like,
  count(*) filter (where manager_ref ~ '^00u')                    as ref_okta_id_like,
  count(*) filter (where manager_ref ~ '^[0-9]+$')                as ref_numeric
from active;
```

**Go/no-go:** if `resolvable / active` is well under ~0.8, **stop Task 12 onwards and revisit Decision 3 with Gareth** (fallback: admin-assigned managers). Tasks 2–11 stay valid either way.

---

### Task 2: Shared types and the reporting tree

**Files:**
- Create: `src/lib/notify/types.ts`
- Create: `src/lib/notify/tree.ts`
- Test: `src/lib/notify/types.test.ts`, `src/lib/notify/tree.test.ts`

**Interfaces:**
- Consumes: DB columns from Task 1.
- Produces:
  - `type Cadence = "daily" | "weekly" | "monthly"`, `CADENCES`, `type NotifyMode = "off" | "preview" | "live"`, `type SendMode = "preview" | "live"`
  - `notifyMode(env?): NotifyMode`, `isCadence(v): v is Cadence`, `isUuid(v): v is string`
  - `interface NotifyEmployee { id; email; fullName; department: string | null; oktaId: string | null; employeeNumber: string | null; managerRef: string | null; employmentStatus: string | null; leaveDate: string | null }`
  - `NOTIFY_EMPLOYEE_COLUMNS: string`, `toNotifyEmployee(row): NotifyEmployee`, `isActiveEmployee(e): boolean`
  - `interface ReportingTree { reportsOf(id): string[]; managerOf(id): string | null; unresolved: string[] }`, `buildReportingTree(employees: NotifyEmployee[]): ReportingTree`

- [x] **Step 1: Write the failing tests**

`src/lib/notify/types.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isActiveEmployee, isCadence, isUuid, notifyMode, toNotifyEmployee } from "./types";

describe("notifyMode", () => {
  it("defaults to off unless explicitly preview or live", () => {
    expect(notifyMode({})).toBe("off");
    expect(notifyMode({ SLACK_NOTIFY_MODE: "LIVE " })).toBe("live");
    expect(notifyMode({ SLACK_NOTIFY_MODE: "preview" })).toBe("preview");
    expect(notifyMode({ SLACK_NOTIFY_MODE: "on" })).toBe("off");
  });
});

describe("input guards (server actions receive arbitrary input)", () => {
  it("accepts only known cadences", () => {
    expect(isCadence("weekly")).toBe(true);
    expect(isCadence("hourly")).toBe(false);
    expect(isCadence(3)).toBe(false);
  });
  it("accepts only uuids", () => {
    expect(isUuid("0b7c7f5e-9d2a-4c1e-8f3a-2a6b9c1d4e5f")).toBe(true);
    expect(isUuid("1; drop table")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe("toNotifyEmployee / isActiveEmployee", () => {
  it("maps a DB row and treats leavers as inactive", () => {
    const e = toNotifyEmployee({
      id: "e1", email: "A@X.COM", full_name: "Ann", department: "Eng", okta_id: "00u9",
      employee_number: null, manager_ref: "00u1", employment_status: "active", leave_date: null,
    });
    expect(e).toEqual({
      id: "e1", email: "a@x.com", fullName: "Ann", department: "Eng", oktaId: "00u9",
      employeeNumber: null, managerRef: "00u1", employmentStatus: "active", leaveDate: null,
    });
    expect(isActiveEmployee(e)).toBe(true);
    expect(isActiveEmployee({ ...e, leaveDate: "2026-03-31" })).toBe(false);
    expect(isActiveEmployee({ ...e, employmentStatus: "DEPROVISIONED" })).toBe(false);
    expect(isActiveEmployee({ ...e, employmentStatus: "leaver" })).toBe(false); // legacy HiBob rows
  });
});
```

`src/lib/notify/tree.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildReportingTree } from "./tree";
import type { NotifyEmployee } from "./types";

const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: id.toUpperCase(), department: "Eng", oktaId: `00u${id}`,
  employeeNumber: null, managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});

describe("buildReportingTree", () => {
  it("returns direct and indirect reports, never the manager", () => {
    const t = buildReportingTree([
      emp("ceo"),
      emp("cto", { managerRef: "00uceo" }),
      emp("dev", { managerRef: "00ucto" }),
      emp("intern", { managerRef: "00udev" }),
    ]);
    expect(t.reportsOf("cto").sort()).toEqual(["dev", "intern"]);
    expect(t.reportsOf("ceo").sort()).toEqual(["cto", "dev", "intern"]);
    expect(t.reportsOf("intern")).toEqual([]);
    expect(t.managerOf("dev")).toBe("cto");
  });

  it("resolves managerRef by Okta id, email or employee number, case-insensitively", () => {
    const t = buildReportingTree([
      emp("m", { employeeNumber: "1001" }),
      emp("a", { managerRef: "00uM" }), // okta id, different case
      emp("b", { managerRef: "M@X.COM" }), // email
      emp("c", { managerRef: "1001" }), // employee number
    ]);
    expect(t.reportsOf("m").sort()).toEqual(["a", "b", "c"]);
  });

  it("terminates on cycles and ignores self-management", () => {
    const t = buildReportingTree([emp("a", { managerRef: "00ub" }), emp("b", { managerRef: "00ua" }), emp("s", { managerRef: "00us" })]);
    expect(t.reportsOf("a")).toEqual(["b"]);
    expect(t.reportsOf("b")).toEqual(["a"]);
    expect(t.reportsOf("s")).toEqual([]);
    expect(t.managerOf("s")).toBeNull();
  });

  it("keeps leavers as descendants but lists only ACTIVE people without a resolvable manager", () => {
    const t = buildReportingTree([
      emp("m"),
      emp("gone", { managerRef: "00um", leaveDate: "2026-03-31", employmentStatus: "deprovisioned" }),
      emp("lost", { managerRef: "nobody@x.com" }),
      emp("oldleaver", { leaveDate: "2025-01-01" }),
    ]);
    expect(t.reportsOf("m")).toEqual(["gone"]);
    expect(t.unresolved.sort()).toEqual(["lost", "m"]);
  });
});
```

- [x] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/notify/types.test.ts src/lib/notify/tree.test.ts`
Expected: FAIL. Cannot find module `./types` / `./tree`.

- [x] **Step 3: Implement**

`src/lib/notify/types.ts`:
```ts
/** Shared types for Slack spend digests (spec: docs/superpowers/specs/2026-09-30-slack-spend-digests-design.md). */

export type Cadence = "daily" | "weekly" | "monthly";
export const CADENCES: readonly Cadence[] = ["daily", "weekly", "monthly"];

/** off = nothing sent; preview = every DM goes to SLACK_PREVIEW_EMAIL; live = DMs go to recipients. */
export type NotifyMode = "off" | "preview" | "live";
export type SendMode = Exclude<NotifyMode, "off">;

/** Fails safe: anything but an explicit preview/live is off. */
export function notifyMode(env: Record<string, string | undefined> = process.env): NotifyMode {
  const m = env.SLACK_NOTIFY_MODE?.trim().toLowerCase();
  return m === "preview" || m === "live" ? m : "off";
}

export function isCadence(v: unknown): v is Cadence {
  return typeof v === "string" && (CADENCES as readonly string[]).includes(v);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export interface NotifyEmployee {
  id: string;
  email: string; // lowercased
  fullName: string;
  department: string | null;
  oktaId: string | null;
  employeeNumber: string | null;
  managerRef: string | null;
  employmentStatus: string | null;
  leaveDate: string | null;
}

export const NOTIFY_EMPLOYEE_COLUMNS =
  "id, email, full_name, department, okta_id, employee_number, manager_ref, employment_status, leave_date";

const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

export function toNotifyEmployee(r: Record<string, unknown>): NotifyEmployee {
  return {
    id: r.id as string,
    email: ((r.email as string) ?? "").toLowerCase(),
    fullName: str(r.full_name) ?? ((r.email as string) ?? "Unknown"),
    department: str(r.department),
    oktaId: str(r.okta_id),
    employeeNumber: str(r.employee_number),
    managerRef: str(r.manager_ref),
    employmentStatus: str(r.employment_status),
    leaveDate: str(r.leave_date),
  };
}

// Okta leaver statuses (normalizers/okta.ts) plus the legacy HiBob "leaver".
const LEFT = new Set(["deprovisioned", "suspended", "leaver"]);

/** Recipients and headcounts use active people only; leavers' past spend still rolls up. */
export function isActiveEmployee(e: Pick<NotifyEmployee, "employmentStatus" | "leaveDate">): boolean {
  return e.leaveDate === null && !LEFT.has((e.employmentStatus ?? "").toLowerCase());
}
```

`src/lib/notify/tree.ts`:
```ts
import { isActiveEmployee, type NotifyEmployee } from "./types";

export interface ReportingTree {
  /** All descendants (direct + indirect), never including the manager. */
  reportsOf(employeeId: string): string[];
  managerOf(employeeId: string): string | null;
  /** ACTIVE employees with no resolvable manager (the admin "Manager chain" card). */
  unresolved: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Okta's managerId is a free-text profile attribute whose format varies by
 * tenant (Okta id, email, or employee number), so it is matched against all
 * three keys. Resolved at read time from the current roster — never stored —
 * so the tree always matches the latest Okta sync. The descendant walk keeps
 * a visited set: bad HR data does produce A→B→A loops.
 */
export function buildReportingTree(employees: NotifyEmployee[]): ReportingTree {
  const idByKey = new Map<string, string>();
  for (const e of employees) {
    for (const k of [e.oktaId, e.email, e.employeeNumber]) {
      if (k && !idByKey.has(norm(k))) idByKey.set(norm(k), e.id);
    }
  }

  const managerOf = new Map<string, string>();
  const children = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const e of employees) {
    const managerId = e.managerRef ? idByKey.get(norm(e.managerRef)) : undefined;
    if (managerId && managerId !== e.id) {
      managerOf.set(e.id, managerId);
      const list = children.get(managerId) ?? [];
      list.push(e.id);
      children.set(managerId, list);
    } else if (isActiveEmployee(e)) {
      unresolved.push(e.id);
    }
  }

  const memo = new Map<string, string[]>();
  return {
    managerOf: (id) => managerOf.get(id) ?? null,
    reportsOf(id) {
      const hit = memo.get(id);
      if (hit) return hit;
      const out: string[] = [];
      const seen = new Set<string>([id]);
      const stack = [...(children.get(id) ?? [])];
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        stack.push(...(children.get(c) ?? []));
      }
      memo.set(id, out);
      return out;
    },
    unresolved,
  };
}
```

- [x] **Step 4: Run the tests and check they pass**

Run: `npx vitest run src/lib/notify/types.test.ts src/lib/notify/tree.test.ts`
Expected: PASS

- [x] **Step 5: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
```bash
git add src/lib/notify/types.ts src/lib/notify/types.test.ts src/lib/notify/tree.ts src/lib/notify/tree.test.ts
git commit -m "feat: notify types + reporting tree from Okta manager refs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Periods, the schedule and the replay guard

**Files:**
- Create: `src/lib/notify/schedule.ts`
- Test: `src/lib/notify/schedule.test.ts`

**Interfaces:**
- Consumes: `parsePeriod`, `stepPeriod`, `currentPeriod`, `type Period` from `src/lib/explore/period.ts`; `Cadence`, `NotifyMode` from Task 2.
- Produces:
  - `interface ChartBucketRange { label: string; from: string; toExclusive: string; current: boolean }`
  - `interface DigestPeriod { cadence: Cadence; key: string; label: string; from: string; toExclusive: string; prev: { from: string; toExclusive: string }; buckets: ChartBucketRange[] }`
  - `CHART_SPAN: Record<Cadence, number>` (14 / 8 / 6), `CADENCE_UNIT: Record<Cadence, "day" | "week" | "month">`, `MONTHLY_WINDOW = { firstDay: 3, lastDay: 5 }`
  - `periodFor(cadence, key, now): DigestPeriod` (throws on a key that isn't that cadence)
  - `latestCompleteKey(cadence, now): string`, `stepKey(cadence, key, dir: -1 | 1, now): string | null`
  - `interface DueDigest { period: DigestPeriod; force: boolean }`, `dueDigests(now, monthlyReady: boolean): DueDigest[]`
  - `resolveRunDate(param: string | null, mode: NotifyMode, realNow: Date): { now: Date } | { error: string }`

- [x] **Step 1: Write the failing test.** `src/lib/notify/schedule.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { dueDigests, latestCompleteKey, periodFor, resolveRunDate, stepKey } from "./schedule";

const at = (iso: string) => new Date(`${iso}T07:00:00Z`);
const due = (iso: string, ready: boolean) => dueDigests(at(iso), ready).map((d) => `${d.period.cadence}:${d.period.key}${d.force ? ":force" : ""}`);

describe("periodFor", () => {
  const now = at("2026-09-30");
  it("daily: the day, the day before, and a 14-day chart", () => {
    const p = periodFor("daily", "2026-09-29", now);
    expect(p).toMatchObject({ label: "29 Sep 2026", from: "2026-09-29", toExclusive: "2026-09-30", prev: { from: "2026-09-28", toExclusive: "2026-09-29" } });
    expect(p.buckets).toHaveLength(14);
    expect(p.buckets[0]).toMatchObject({ label: "16 Sep", from: "2026-09-16", current: false });
    expect(p.buckets[1].label).toBe("17");
    expect(p.buckets[13]).toMatchObject({ label: "29", from: "2026-09-29", current: true });
  });
  it("weekly: ISO week, previous week, 8 Monday-labelled buckets", () => {
    const p = periodFor("weekly", "2026-W39", now);
    expect(p).toMatchObject({ label: "21–27 Sep 2026", from: "2026-09-21", toExclusive: "2026-09-28", prev: { from: "2026-09-14" } });
    expect(p.buckets.map((b) => b.label)).toEqual(["3 Aug", "10", "17", "24", "31", "7 Sep", "14", "21"]);
  });
  it("monthly: calendar month, previous month, 6 month buckets", () => {
    const p = periodFor("monthly", "2026-09", now);
    expect(p).toMatchObject({ label: "September 2026", from: "2026-09-01", toExclusive: "2026-10-01", prev: { from: "2026-08-01", toExclusive: "2026-09-01" } });
    expect(p.buckets.map((b) => b.label)).toEqual(["Apr", "May", "Jun", "Jul", "Aug", "Sep"]);
  });
  it("rejects a key of the wrong cadence or a malformed key (parsePeriod silently falls back)", () => {
    expect(() => periodFor("weekly", "2026-09", now)).toThrow();
    expect(() => periodFor("monthly", "2026-09x", now)).toThrow();
    expect(() => periodFor("daily", "2026-02-30", now)).toThrow();
  });
});

describe("latestCompleteKey / stepKey", () => {
  it("handles the ISO 53-week year boundary", () => {
    expect(latestCompleteKey("weekly", at("2027-01-04"))).toBe("2026-W53");
    expect(latestCompleteKey("daily", at("2026-10-01"))).toBe("2026-09-30");
    expect(latestCompleteKey("monthly", at("2026-10-03"))).toBe("2026-09");
  });
  it("never steps past the latest complete period", () => {
    const now = at("2026-09-30");
    expect(stepKey("daily", "2026-09-29", 1, now)).toBeNull();
    expect(stepKey("daily", "2026-09-29", -1, now)).toBe("2026-09-28");
    expect(stepKey("weekly", "2026-W38", 1, now)).toBe("2026-W39");
  });
});

describe("dueDigests", () => {
  it("daily always; weekly on Mondays", () => {
    expect(due("2026-09-30", true)).toEqual(["daily:2026-09-29"]);
    expect(due("2026-09-28", true)).toEqual(["daily:2026-09-27", "weekly:2026-W39"]);
  });
  it("monthly only in the 3rd–5th window: when ready, or forced on the 5th", () => {
    expect(due("2026-10-01", true)).toEqual(["daily:2026-09-30"]);
    expect(due("2026-10-02", true)).toEqual(["daily:2026-10-01"]);
    expect(due("2026-10-03", true)).toEqual(["daily:2026-10-02", "monthly:2026-09"]);
    expect(due("2026-10-03", false)).toEqual(["daily:2026-10-02"]);
    expect(due("2026-10-05", false)).toEqual(["daily:2026-10-04", "weekly:2026-W40", "monthly:2026-09:force"]);
    expect(due("2026-10-06", true)).toEqual(["daily:2026-10-05"]);
  });
});

describe("resolveRunDate", () => {
  const real = new Date("2026-09-30T07:02:00Z");
  it("uses real time without a param", () => {
    expect(resolveRunDate(null, "live", real)).toEqual({ now: real });
  });
  it("refuses replays outside preview mode (would DM real people about old periods)", () => {
    expect(resolveRunDate("2026-09-28", "live", real)).toHaveProperty("error");
  });
  it("replays a valid day at 07:00 UTC in preview, rejects impossible dates", () => {
    expect(resolveRunDate("2026-09-28", "preview", real)).toEqual({ now: new Date("2026-09-28T07:00:00Z") });
    expect(resolveRunDate("2026-02-30", "preview", real)).toHaveProperty("error");
    expect(resolveRunDate("yesterday", "preview", real)).toHaveProperty("error");
  });
});
```

- [x] **Step 2: Run the test and check it fails**

Run: `npx vitest run src/lib/notify/schedule.test.ts`
Expected: FAIL. Cannot find module `./schedule`.

- [x] **Step 3: Implement.** `src/lib/notify/schedule.ts`:
```ts
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
```

- [x] **Step 4: Run the test and check it passes**

Run: `npx vitest run src/lib/notify/schedule.test.ts`
Expected: PASS

- [x] **Step 5: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
```bash
git add src/lib/notify/schedule.ts src/lib/notify/schedule.test.ts
git commit -m "feat: digest periods, due cadences and the preview-only replay guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Freshness, monthly readiness and caveats

**Files:**
- Create: `src/lib/notify/freshness.ts`
- Test: `src/lib/notify/freshness.test.ts`

**Interfaces:**
- Consumes: `DigestPeriod` (Task 3); `CoverageMonthRow` from `src/lib/queries/import-coverage.ts`; `MONTHLY_SNAPSHOT_SOURCES` from `src/lib/explore/shape.ts`; `VENDOR_LABEL`, `Vendor` from `src/lib/types.ts`.
- Produces:
  - `interface SyncRunRow { source: string; status: string; startedAt: string }`
  - `SYNCED_SOURCES: readonly Vendor[]`
  - `interface SourceFreshness { source: Vendor; lastSyncFailed: boolean; usageThrough: string | null }`
  - `sourceFreshness(runs: SyncRunRow[], usageHorizons: Record<string, string>): SourceFreshness[]`
  - `anySyncSucceededToday(runs: SyncRunRow[], now: Date): boolean`
  - `interface MissingImport { source: Vendor; label: string }`
  - `monthlyReadiness(rows: CoverageMonthRow[], month: string): { ready: boolean; missing: MissingImport[] }`
  - `caveatsFor(args: { period: DigestPeriod; sourcesUsed: ReadonlySet<string>; freshness: SourceFreshness[]; missingImports: MissingImport[] }): string[]`

- [x] **Step 1: Write the failing test.** `src/lib/notify/freshness.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import { anySyncSucceededToday, caveatsFor, monthlyReadiness, sourceFreshness, type SyncRunRow } from "./freshness";
import { periodFor } from "./schedule";

const runs: SyncRunRow[] = [
  { source: "cursor", status: "success", startedAt: "2026-09-29T06:00:05Z" },
  { source: "cursor", status: "failed", startedAt: "2026-09-30T06:00:05Z" },
  { source: "anthropic", status: "success", startedAt: "2026-09-30T06:00:04Z" },
  { source: "okta", status: "success", startedAt: "2026-09-30T06:00:01Z" },
];

describe("sourceFreshness", () => {
  it("flags a source whose LATEST run failed and carries each usage horizon", () => {
    const f = sourceFreshness(runs, { cursor: "2026-09-28", anthropic: "2026-09-29", chatgpt_business: "2026-09-10", claude_team: "2026-09-01" });
    expect(f.find((x) => x.source === "cursor")).toEqual({ source: "cursor", lastSyncFailed: true, usageThrough: "2026-09-28" });
    expect(f.find((x) => x.source === "anthropic")).toEqual({ source: "anthropic", lastSyncFailed: false, usageThrough: "2026-09-29" });
    expect(f.find((x) => x.source === "chatgpt_business")).toEqual({ source: "chatgpt_business", lastSyncFailed: false, usageThrough: "2026-09-10" });
  });
  it("skips monthly-snapshot sources: Claude Team's usage lump is stamped on the 1st, not a daily horizon", () => {
    const f = sourceFreshness(runs, { claude_team: "2026-09-01" });
    expect(f.some((x) => x.source === "claude_team")).toBe(false);
  });
});

describe("anySyncSucceededToday", () => {
  it("counts only spend sources (not okta) and only today's runs", () => {
    const now = new Date("2026-09-30T07:00:00Z");
    expect(anySyncSucceededToday(runs, now)).toBe(true); // anthropic
    expect(anySyncSucceededToday(runs.filter((r) => r.source !== "anthropic"), now)).toBe(false);
    expect(anySyncSucceededToday(runs, new Date("2026-10-01T07:00:00Z"))).toBe(false);
  });
});

const cell = { totalUsd: 1, lastImport: null };
const row = (month: string, over: Partial<CoverageMonthRow> = {}): CoverageMonthRow => ({
  month, chatgptSeats: null, chatgptCredits: null, claudeSpend: null, claudeSeats: null, ...over,
});

describe("monthlyReadiness", () => {
  it("requires every manual column the org used in either of the two previous months", () => {
    const rows = [row("2026-09", { chatgptSeats: cell }), row("2026-08", { chatgptSeats: cell, claudeSpend: cell }), row("2026-07", { claudeSeats: cell })];
    expect(monthlyReadiness(rows, "2026-09")).toEqual({
      ready: false,
      missing: [
        { source: "claude_team", label: "Claude Team usage" },
        { source: "claude_team", label: "Claude Team seats" },
      ],
    });
  });
  it("is ready when nothing is missing, and when there is no manual data at all", () => {
    expect(monthlyReadiness([row("2026-09", { claudeSpend: cell }), row("2026-08", { claudeSpend: cell })], "2026-09").ready).toBe(true);
    expect(monthlyReadiness([], "2026-09")).toEqual({ ready: true, missing: [] });
  });
});

describe("caveatsFor", () => {
  const weekly = periodFor("weekly", "2026-W39", new Date("2026-09-30T07:00:00Z")); // 21–27 Sep
  it("warns only about sources this recipient actually uses", () => {
    const freshness = [
      { source: "cursor" as const, lastSyncFailed: false, usageThrough: "2026-09-26" },
      { source: "openai" as const, lastSyncFailed: true, usageThrough: "2026-09-29" },
      { source: "anthropic" as const, lastSyncFailed: false, usageThrough: "2026-09-29" },
    ];
    expect(caveatsFor({ period: weekly, sourcesUsed: new Set(["cursor", "anthropic"]), freshness, missingImports: [] })).toEqual([
      "⚠ Cursor data may be incomplete (last updated 26 Sep)",
    ]);
  });
  it("adds missing manual imports on monthly digests only, for used sources", () => {
    const monthly = periodFor("monthly", "2026-09", new Date("2026-10-05T07:00:00Z"));
    const missingImports = [{ source: "chatgpt_business" as const, label: "ChatGPT Business seats" }, { source: "claude_team" as const, label: "Claude Team usage" }];
    expect(caveatsFor({ period: monthly, sourcesUsed: new Set(["chatgpt_business"]), freshness: [], missingImports })).toEqual([
      "⚠ ChatGPT Business seats for September not imported yet",
    ]);
    expect(caveatsFor({ period: weekly, sourcesUsed: new Set(["chatgpt_business"]), freshness: [], missingImports })).toEqual([]);
  });
});
```

- [x] **Step 2: Run the test and check it fails**

Run: `npx vitest run src/lib/notify/freshness.test.ts`
Expected: FAIL. Cannot find module `./freshness`.

- [x] **Step 3: Implement.** `src/lib/notify/freshness.ts`:
```ts
import { MONTHLY_SNAPSHOT_SOURCES } from "@/lib/explore/shape";
import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import type { DigestPeriod } from "./schedule";

export interface SyncRunRow {
  source: string;
  status: string;
  startedAt: string; // ISO timestamp
}

/** Spend sources refreshed by the daily API sync (their sync_runs.source equals the vendor). */
export const SYNCED_SOURCES: readonly Vendor[] = ["cursor", "anthropic", "openai", "vercel", "openrouter"];

export interface SourceFreshness {
  source: Vendor;
  lastSyncFailed: boolean;
  usageThrough: string | null; // latest daily-usage fact day
}

/**
 * Per-source freshness from the latest sync run and the latest daily USAGE
 * day. Monthly-snapshot sources (Claude Team) are skipped: their usage is one
 * fact stamped on the 1st, so its "horizon" would flag every month as stale.
 */
export function sourceFreshness(runs: SyncRunRow[], usageHorizons: Record<string, string>): SourceFreshness[] {
  const latestRun = new Map<string, SyncRunRow>();
  for (const r of runs) {
    const cur = latestRun.get(r.source);
    if (!cur || r.startedAt > cur.startedAt) latestRun.set(r.source, r);
  }
  const sources = new Set<string>([...SYNCED_SOURCES, ...Object.keys(usageHorizons)]);
  const out: SourceFreshness[] = [];
  for (const source of sources) {
    if (MONTHLY_SNAPSHOT_SOURCES.has(source)) continue;
    out.push({
      source: source as Vendor,
      lastSyncFailed: (SYNCED_SOURCES as readonly string[]).includes(source) && latestRun.get(source)?.status === "failed",
      usageThrough: usageHorizons[source] ?? null,
    });
  }
  return out;
}

/** False when not one spend source synced successfully today — daily/weekly sends are then skipped. */
export function anySyncSucceededToday(runs: SyncRunRow[], now: Date): boolean {
  const today = now.toISOString().slice(0, 10);
  return runs.some(
    (r) => (SYNCED_SOURCES as readonly string[]).includes(r.source) && r.status === "success" && r.startedAt.slice(0, 10) === today,
  );
}

export interface MissingImport {
  source: Vendor;
  label: string;
}

const MANUAL_COLUMNS = [
  { key: "chatgptSeats", source: "chatgpt_business", label: "ChatGPT Business seats" },
  { key: "chatgptCredits", source: "chatgpt_business", label: "ChatGPT Business credits" },
  { key: "claudeSpend", source: "claude_team", label: "Claude Team usage" },
  { key: "claudeSeats", source: "claude_team", label: "Claude Team seats" },
] as const;

const addMonths = (ym: string, k: number) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7);
};

/**
 * A month is ready when every manual-import column the org used in either of
 * the two months before it has data for it (a column nobody has used lately
 * can't block the recap forever).
 */
export function monthlyReadiness(rows: CoverageMonthRow[], month: string): { ready: boolean; missing: MissingImport[] } {
  const at = (m: string) => rows.find((r) => r.month === m);
  const cur = at(month);
  const p1 = at(addMonths(month, -1));
  const p2 = at(addMonths(month, -2));
  const missing = MANUAL_COLUMNS.filter((c) => (p1?.[c.key] || p2?.[c.key]) && !cur?.[c.key]).map(({ source, label }) => ({
    source: source as Vendor,
    label,
  }));
  return { ready: missing.length === 0, missing };
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${SHORT[Number(d.slice(5, 7)) - 1]}`;
const lastDayOf = (p: DigestPeriod) => new Date(Date.parse(`${p.toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Caveats for ONE recipient: only sources in their (or their tree's) chart span. */
export function caveatsFor(args: {
  period: DigestPeriod;
  sourcesUsed: ReadonlySet<string>;
  freshness: SourceFreshness[];
  missingImports: MissingImport[];
}): string[] {
  const { period, sourcesUsed, freshness, missingImports } = args;
  const lastDay = lastDayOf(period);
  const out: string[] = [];
  for (const f of freshness) {
    if (!sourcesUsed.has(f.source)) continue;
    const behind = f.usageThrough !== null && f.usageThrough < lastDay;
    if (f.lastSyncFailed || behind) {
      out.push(`⚠ ${VENDOR_LABEL[f.source]} data may be incomplete${f.usageThrough ? ` (last updated ${dayLabel(f.usageThrough)})` : ""}`);
    }
  }
  if (period.cadence === "monthly") {
    const month = FULL[Number(period.key.slice(5, 7)) - 1];
    for (const m of missingImports) if (sourcesUsed.has(m.source)) out.push(`⚠ ${m.label} for ${month} not imported yet`);
  }
  return out;
}
```

- [x] **Step 4: Run the test and check it passes**

Run: `npx vitest run src/lib/notify/freshness.test.ts`
Expected: PASS

- [x] **Step 5: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
```bash
git add src/lib/notify/freshness.ts src/lib/notify/freshness.test.ts
git commit -m "feat: per-recipient freshness caveats + monthly import readiness

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The digest builder

**Files:**
- Create: `src/lib/notify/digest.ts`
- Test: `src/lib/notify/digest.test.ts`

**Interfaces:**
- Consumes: `ShapeFact`, `isMonthlyLevelFact`, `dimLabel`, `dimColorFor`, `UNATTRIBUTED` (`src/lib/explore/shape.ts`); `vendorKeyOf` (`src/lib/explore/vendor-filter.ts`); `projectPeriodEnd` (`src/lib/explore/project.ts`); `DigestPeriod` (Task 3); `caveatsFor`, `SourceFreshness`, `MissingImport` (Task 4); `NotifyEmployee`, `isActiveEmployee` (Task 2).
- Produces:
  - `type Basis = "usage" | "total"`
  - `interface ToolAmount { key: string; label: string; color: string; usd: number }`
  - `interface ChartBucket { label: string; current: boolean; byTool: Record<string, number>; totalUsd: number }`
  - `interface MonthContext { monthLabel: string; soFarUsd: number; projectedUsd: number | null; complete: boolean }`
  - `interface DigestSection { basis; headlineUsd; prevUsd; deltaPct: number | null; byTool: ToolAmount[]; chartTools: ToolAmount[]; chart: ChartBucket[]; month: MonthContext | null }`
  - `interface TopPerson { employeeId; name; usd; href }`, `interface ReportsSection extends DigestSection { headcount; top: TopPerson[]; othersCount; othersUsd }`
  - `interface Digest { recipient: { employeeId; name; team: string | null }; period: DigestPeriod; you: DigestSection; reports: ReportsSection | null; caveats: string[]; dashboardUrl: string }`
  - `interface DigestInput { recipient: NotifyEmployee; reportIds: string[]; employeesById: ReadonlyMap<string, NotifyEmployee>; facts: ShapeFact[]; period: DigestPeriod; now: Date; sourceHorizons: Record<string, string>; toolColors: Record<string, string>; freshness: SourceFreshness[]; missingImports: MissingImport[]; baseUrl: string }`
  - `personHref(baseUrl, e: Pick<NotifyEmployee, "id" | "department">): string`, `buildDigest(input: DigestInput): Digest | null`

- [x] **Step 1: Write the failing test.** `src/lib/notify/digest.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import type { CostType, Vendor } from "@/lib/types";
import { buildDigest, type DigestInput } from "./digest";
import { periodFor } from "./schedule";
import type { NotifyEmployee } from "./types";

const now = new Date("2026-09-30T07:00:00Z");
const emp = (id: string, fullName: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName, department: "Engineering", oktaId: null, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
const fact = (day: string, source: Vendor, costType: CostType, costUsd: number, employeeId: string | null, model = ""): ShapeFact => ({
  day, source, costType, costUsd, employeeId, department: "Engineering", fullName: null, entityKey: employeeId ?? "dept", model,
});

const people = [
  emp("m", "Priya Nair"),
  emp("a", "Alex Kim"),
  emp("s", "Sam Lee", { department: "Data Science" }),
  emp("l", "Former Person", { employmentStatus: "deprovisioned", leaveDate: "2026-09-26" }),
  emp("n", "New Joiner"),
];
const byId = new Map(people.map((p) => [p.id, p]));

const facts: ShapeFact[] = [
  fact("2026-09-22", "cursor", "overage", 30.1, "m"),
  fact("2026-09-23", "anthropic", "metered", 8.1, "m"),
  fact("2026-09-15", "cursor", "overage", 34.1, "m"), // previous week
  fact("2026-09-01", "cursor", "seat", 40, "m"), // monthly-level: not in weekly headline
  fact("2026-09-24", "cursor", "overage", 140, "a"),
  fact("2026-09-25", "anthropic", "metered", 96, "s"),
  fact("2026-09-21", "openrouter", "metered", 42, "l"), // leaver's spend still counts
  fact("2026-09-01", "claude_team", "overage", 500, "a"), // Claude Team monthly lump
  fact("2026-09-24", "other", "subscription", 999, null, "Figma AI"), // person-less
];

const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  recipient: byId.get("m")!, reportIds: ["a", "s", "l"], employeesById: byId, facts,
  period: periodFor("weekly", "2026-W39", now), now, sourceHorizons: {}, toolColors: {},
  freshness: [], missingImports: [], baseUrl: "https://x.test", ...over,
});

describe("buildDigest — weekly (usage basis)", () => {
  const d = buildDigest(input())!;

  it("headline is usage only, compared with the previous week", () => {
    expect(d.you).toMatchObject({ basis: "usage", headlineUsd: 38.2, prevUsd: 34.1, deltaPct: 12 });
    expect(d.you.byTool.map((t) => [t.key, t.label, t.usd])).toEqual([["cursor", "Cursor", 30.1], ["anthropic", "Anthropic API", 8.1]]);
  });

  it("excludes Claude Team's monthly lump and person-less facts from reports", () => {
    expect(d.reports).toMatchObject({ headlineUsd: 278, headcount: 2, othersCount: 0 });
    expect(d.reports!.top.map((p) => [p.name, p.usd])).toEqual([["Alex Kim", 140], ["Sam Lee", 96], ["Former Person", 42]]);
    expect(d.reports!.top[1].href).toBe("https://x.test/explore/Data%20Science/s");
  });

  it("carries a month-so-far line (all cost types) and a projection for the current month", () => {
    expect(d.you.month).toMatchObject({ monthLabel: "September", soFarUsd: 112.3, complete: false });
    expect(typeof d.you.month!.projectedUsd).toBe("number");
  });

  it("charts 8 weekly buckets with the current one last", () => {
    expect(d.you.chart).toHaveLength(8);
    expect(d.you.chart[7]).toMatchObject({ current: true, totalUsd: 38.2, byTool: { cursor: 30.1, anthropic: 8.1 } });
    expect(d.you.chart[6]).toMatchObject({ current: false, totalUsd: 34.1 });
  });

  it("links to the recipient's Explore page", () => {
    expect(d.dashboardUrl).toBe("https://x.test/explore/Engineering/m");
  });
});

describe("buildDigest — monthly (total basis)", () => {
  it("monthly total equals the person's summed facts to the cent, with no month line", () => {
    const aug = [fact("2026-08-01", "cursor", "seat", 40, "m"), fact("2026-08-10", "cursor", "overage", 20.05, "m"), fact("2026-07-03", "cursor", "overage", 7, "m")];
    const d = buildDigest(input({ facts: aug, reportIds: [], period: periodFor("monthly", "2026-08", now) }))!;
    expect(d.you).toMatchObject({ basis: "total", headlineUsd: 60.05, prevUsd: 7, month: null });
    expect(d.reports).toBeNull();
  });
});

describe("buildDigest — daily", () => {
  it("skips (null) when neither the recipient nor anyone in their tree had usage", () => {
    expect(buildDigest(input({ period: periodFor("daily", "2026-09-26", now) }))).toBeNull();
  });
  it("still sends when only a report had usage", () => {
    const d = buildDigest(input({ period: periodFor("daily", "2026-09-24", now) }))!;
    expect(d.you.headlineUsd).toBe(0);
    expect(d.reports!.headlineUsd).toBe(140);
  });
});

describe("buildDigest — edge cases", () => {
  it("a new joiner with no facts gets a valid $0 digest (no projection on an empty set)", () => {
    const d = buildDigest(input({ recipient: byId.get("n")!, reportIds: [], facts: [] }))!;
    expect(d.you).toMatchObject({ headlineUsd: 0, prevUsd: 0, deltaPct: null, byTool: [] });
    expect(d.you.month).toMatchObject({ soFarUsd: 0, projectedUsd: null });
  });

  it("top 5 + others add up to the reports total", () => {
    const many = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((id) => emp(id, `Person ${id}`));
    const f = many.map((p, i) => fact("2026-09-22", "cursor", "overage", 10 + i, p.id));
    const map = new Map([...byId, ...many.map((p) => [p.id, p] as const)]);
    const d = buildDigest(input({ facts: f, reportIds: many.map((p) => p.id), employeesById: map }))!;
    const r = d.reports!;
    expect(r.top).toHaveLength(5);
    expect(r.othersCount).toBe(2);
    expect(Math.round((r.top.reduce((s, p) => s + p.usd, 0) + r.othersUsd) * 100) / 100).toBe(r.headlineUsd);
  });

  it("caveats mention only sources the recipient or their tree used", () => {
    const d = buildDigest(input({
      freshness: [
        { source: "cursor", lastSyncFailed: true, usageThrough: "2026-09-29" },
        { source: "openai", lastSyncFailed: true, usageThrough: "2026-09-29" },
      ],
    }))!;
    expect(d.caveats).toEqual(["⚠ Cursor data may be incomplete (last updated 29 Sep)"]);
  });
});
```

- [x] **Step 2: Run the test and check it fails**

Run: `npx vitest run src/lib/notify/digest.test.ts`
Expected: FAIL. Cannot find module `./digest`.

- [x] **Step 3: Implement.** `src/lib/notify/digest.ts`:
```ts
import { dimColorFor, dimLabel, isMonthlyLevelFact, UNATTRIBUTED, type ShapeFact } from "@/lib/explore/shape";
import { vendorKeyOf } from "@/lib/explore/vendor-filter";
import { projectPeriodEnd } from "@/lib/explore/project";
import { caveatsFor, type MissingImport, type SourceFreshness } from "./freshness";
import type { DigestPeriod } from "./schedule";
import { isActiveEmployee, type NotifyEmployee } from "./types";

export type Basis = "usage" | "total";

export interface ToolAmount {
  key: string; // vendorKeyOf: a vendor, or "other:<tool>"
  label: string;
  color: string;
  usd: number;
}

export interface ChartBucket {
  label: string;
  current: boolean;
  byTool: Record<string, number>;
  totalUsd: number;
}

export interface MonthContext {
  monthLabel: string; // "September"
  soFarUsd: number; // all cost types
  projectedUsd: number | null; // current month only
  complete: boolean; // the month has ended → "September total $X"
}

export interface DigestSection {
  basis: Basis;
  headlineUsd: number;
  prevUsd: number;
  deltaPct: number | null; // null when the previous period was $0
  byTool: ToolAmount[]; // this period, desc
  chartTools: ToolAmount[]; // across the chart span, desc — stack order + colours
  chart: ChartBucket[];
  month: MonthContext | null; // daily/weekly only
}

export interface TopPerson {
  employeeId: string;
  name: string;
  usd: number;
  href: string;
}

export interface ReportsSection extends DigestSection {
  headcount: number; // ACTIVE descendants; leavers' spend still counts in the figures
  top: TopPerson[];
  othersCount: number;
  othersUsd: number;
}

export interface Digest {
  recipient: { employeeId: string; name: string; team: string | null };
  period: DigestPeriod;
  you: DigestSection;
  reports: ReportsSection | null; // present iff the recipient has descendants
  caveats: string[];
  dashboardUrl: string;
}

export interface DigestInput {
  recipient: NotifyEmployee;
  reportIds: string[];
  employeesById: ReadonlyMap<string, NotifyEmployee>;
  facts: ShapeFact[];
  period: DigestPeriod;
  now: Date;
  sourceHorizons: Record<string, string>;
  toolColors: Record<string, string>;
  freshness: SourceFreshness[];
  missingImports: MissingImport[];
  baseUrl: string;
}

const TOP_N = 5;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Cents, with -0 normalised (formatUsd(-0) would print "-$0.00"). */
const round2 = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
};
const inRange = (f: ShapeFact, from: string, to: string) => f.day >= from && f.day < to;
const total = (fs: ShapeFact[]) => fs.reduce((s, f) => s + f.costUsd, 0);

export function personHref(baseUrl: string, e: Pick<NotifyEmployee, "id" | "department">): string {
  return `${baseUrl}/explore/${encodeURIComponent(e.department ?? UNATTRIBUTED)}/${e.id}`;
}

function sumBy(facts: ShapeFact[], key: (f: ShapeFact) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of facts) m.set(key(f), (m.get(key(f)) ?? 0) + f.costUsd);
  return m;
}

function toolAmounts(totals: Map<string, number>, toolColors: Record<string, string>): ToolAmount[] {
  return [...totals]
    .map(([key, usd]) => ({ key, label: dimLabel("vendor", key), color: dimColorFor("vendor", key, toolColors), usd: round2(usd) }))
    .filter((t) => t.usd > 0)
    .sort((a, b) => b.usd - a.usd || a.label.localeCompare(b.label));
}

/** Daily/weekly count usage only; seats, subscriptions and monthly usage lumps would distort short periods. */
const basisOf = (p: DigestPeriod): Basis => (p.cadence === "monthly" ? "total" : "usage");
const counted = (facts: ShapeFact[], basis: Basis) => (basis === "usage" ? facts.filter((f) => !isMonthlyLevelFact(f)) : facts);

function monthContext(pop: ShapeFact[], { period, now, sourceHorizons }: DigestInput): MonthContext {
  const lastDay = new Date(Date.parse(`${period.toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const month = lastDay.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const toExclusive = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const complete = month !== now.toISOString().slice(0, 7);
  // projectPeriodEnd reads facts[0] — never call it on an empty population.
  const projection =
    complete || pop.length === 0
      ? null
      : projectPeriodEnd(pop, now, { granularity: "month", from, toExclusive, label: `${MONTHS[m - 1]} ${y}` }, sourceHorizons);
  return {
    monthLabel: MONTHS[m - 1],
    soFarUsd: round2(total(pop.filter((f) => inRange(f, from, toExclusive)))),
    projectedUsd: projection ? round2(projection.projectedUsd) : null,
    complete,
  };
}

function section(pop: ShapeFact[], input: DigestInput): DigestSection {
  const { period, toolColors } = input;
  const basis = basisOf(period);
  const base = counted(pop, basis);
  const cur = base.filter((f) => inRange(f, period.from, period.toExclusive));
  const headlineUsd = round2(total(cur));
  const prevUsd = round2(total(base.filter((f) => inRange(f, period.prev.from, period.prev.toExclusive))));
  const inSpan = base.filter((f) => inRange(f, period.buckets[0].from, period.toExclusive));
  const chart = period.buckets.map((b) => {
    const m = sumBy(inSpan.filter((f) => inRange(f, b.from, b.toExclusive)), vendorKeyOf);
    return {
      label: b.label,
      current: b.current,
      byTool: Object.fromEntries([...m].map(([k, v]) => [k, round2(v)])),
      totalUsd: round2([...m.values()].reduce((s, v) => s + v, 0)),
    };
  });
  return {
    basis,
    headlineUsd,
    prevUsd,
    deltaPct: prevUsd > 0 ? Math.round(((headlineUsd - prevUsd) / prevUsd) * 1000) / 10 : null,
    byTool: toolAmounts(sumBy(cur, vendorKeyOf), toolColors),
    chartTools: toolAmounts(sumBy(inSpan, vendorKeyOf), toolColors),
    chart,
    month: basis === "usage" ? monthContext(pop, input) : null,
  };
}

/**
 * One recipient's digest for one period, or null to skip (daily with no usage
 * anywhere in their tree). Person-less facts (department subscriptions,
 * unkeyed rows) have no employeeId, so they never enter either population.
 */
export function buildDigest(input: DigestInput): Digest | null {
  const { recipient, reportIds, employeesById, facts, period, baseUrl } = input;
  const reportSet = new Set(reportIds);
  const youFacts = facts.filter((f) => f.employeeId === recipient.id);
  const reportFacts = reportIds.length ? facts.filter((f) => f.employeeId !== null && reportSet.has(f.employeeId)) : [];

  const you = section(youFacts, input);
  let reports: ReportsSection | null = null;
  if (reportIds.length) {
    const base = section(reportFacts, input);
    const perPerson = sumBy(
      counted(reportFacts, base.basis).filter((f) => inRange(f, period.from, period.toExclusive)),
      (f) => f.employeeId as string,
    );
    const ranked = [...perPerson]
      .map(([id, usd]) => ({ id, usd: round2(usd), name: employeesById.get(id)?.fullName ?? "Unknown" }))
      .filter((p) => p.usd > 0)
      .sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name));
    const rest = ranked.slice(TOP_N);
    reports = {
      ...base,
      headcount: reportIds.filter((id) => {
        const e = employeesById.get(id);
        return e ? isActiveEmployee(e) : false;
      }).length,
      top: ranked.slice(0, TOP_N).map((p) => ({
        employeeId: p.id,
        name: p.name,
        usd: p.usd,
        href: personHref(baseUrl, employeesById.get(p.id) ?? { id: p.id, department: null }),
      })),
      othersCount: rest.length,
      othersUsd: round2(rest.reduce((s, p) => s + p.usd, 0)),
    };
  }

  if (period.cadence === "daily" && you.headlineUsd === 0 && (reports?.headlineUsd ?? 0) === 0) return null;

  const sourcesUsed = new Set<string>(
    [...youFacts, ...reportFacts].filter((f) => inRange(f, period.buckets[0].from, period.toExclusive)).map((f) => f.source),
  );
  return {
    recipient: { employeeId: recipient.id, name: recipient.fullName, team: recipient.department },
    period,
    you,
    reports,
    caveats: caveatsFor({ period, sourcesUsed, freshness: input.freshness, missingImports: input.missingImports }),
    dashboardUrl: personHref(baseUrl, recipient),
  };
}
```

- [x] **Step 4: Run the test and check it passes**

Run: `npx vitest run src/lib/notify/digest.test.ts`
Expected: PASS. If the `soFarUsd` assertion fails, recompute it: 30.10 + 8.10 + 34.10 + 40 = 112.30 (all of m's September facts, every cost type).

- [x] **Step 5: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
```bash
git add src/lib/notify/digest.ts src/lib/notify/digest.test.ts
git commit -m "feat: digest builder — usage/total headlines, reports tree, charts, caveats

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Chart layout and PNG rendering

**Files:**
- Create: `src/lib/notify/chart.ts`
- Create: `src/lib/notify/chart-image.tsx`
- Test: `src/lib/notify/chart.test.ts`

**Interfaces:**
- Consumes: `ChartBucket`, `ToolAmount` (Task 5); `formatUsd` (`src/lib/utils.ts`); `ImageResponse` (`next/og`).
- Produces:
  - `CHART_W = 920`, `CHART_H = 380`, `CHART_PLOT = { left: 88, right: 900, top: 76, bottom: 296 }`
  - `interface ChartSegment { y: number; h: number; color: string }`, `interface ChartBar { x: number; w: number; label: string; current: boolean; segments: ChartSegment[]; totalLabel: string | null }`
  - `interface ChartLayout { width: number; height: number; title: string; gridlines: { y: number; label: string }[]; bars: ChartBar[]; legend: { color: string; text: string }[] }`
  - `niceMax(v: number): number`, `axisUsd(v: number): string`, `chartLayout(title: string, buckets: ChartBucket[], chartTools: ToolAmount[], legendTools: ToolAmount[]): ChartLayout`
  - `renderChartPng(layout: ChartLayout): Promise<Uint8Array<ArrayBuffer>>`

- [x] **Step 1: Write the failing test.** `src/lib/notify/chart.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { axisUsd, CHART_PLOT, chartLayout, niceMax } from "./chart";
import type { ChartBucket, ToolAmount } from "./digest";

const tools: ToolAmount[] = [
  { key: "cursor", label: "Cursor", color: "#f59e0b", usd: 380 },
  { key: "anthropic", label: "Anthropic API", color: "#d2845a", usd: 190 },
];
const buckets: ChartBucket[] = [
  { label: "14 Sep", current: false, byTool: { cursor: 300, anthropic: 150 }, totalUsd: 450 },
  { label: "21", current: true, byTool: { cursor: 380, anthropic: 190 }, totalUsd: 570 },
];

describe("niceMax / axisUsd", () => {
  it("rounds up to 1/2/2.5/5 × 10^k, with a floor for empty charts", () => {
    expect([niceMax(0), niceMax(38.2), niceMax(570), niceMax(1100), niceMax(210)]).toEqual([10, 50, 1000, 2000, 250]);
  });
  it("formats compact axis labels", () => {
    expect([axisUsd(0), axisUsd(25), axisUsd(125), axisUsd(1000), axisUsd(2500)]).toEqual(["$0", "$25", "$125", "$1k", "$2.5k"]);
  });
});

describe("chartLayout", () => {
  const l = chartLayout("YOU · USAGE, LAST 8 WEEKS", buckets, tools, tools);

  it("stacks the biggest tool at the bottom, sitting on the baseline", () => {
    const [first] = l.bars[1].segments;
    expect(first.color).toBe("#f59e0b");
    expect(first.y + first.h).toBeCloseTo(CHART_PLOT.bottom, 5);
    const top = l.bars[1].segments[1];
    expect(top.y + top.h).toBeCloseTo(first.y, 5);
  });

  it("labels only the current bar's total and keeps every bar inside the plot", () => {
    expect(l.bars.map((b) => b.totalLabel)).toEqual([null, "$570"]);
    for (const b of l.bars) expect(b.x + b.w).toBeLessThanOrEqual(CHART_PLOT.right);
  });

  it("draws three gridlines on the section's own scale", () => {
    expect(l.gridlines.map((g) => g.label)).toEqual(["$0", "$500", "$1k"]);
    expect(l.gridlines[0].y).toBe(CHART_PLOT.bottom);
  });

  it("handles an all-zero chart (no segments, $0/$5/$10 axis)", () => {
    const empty = chartLayout("YOU", [{ label: "1", current: true, byTool: {}, totalUsd: 0 }], [], []);
    expect(empty.bars[0].segments).toEqual([]);
    expect(empty.gridlines.map((g) => g.label)).toEqual(["$0", "$5", "$10"]);
  });

  it("caps the legend at 4 tools plus a '+N more' entry", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, label: `Tool ${i}`, color: "#000", usd: 10 - i }));
    const legend = chartLayout("YOU", buckets, six, six).legend;
    expect(legend).toHaveLength(5);
    expect(legend[4].text).toBe("+2 more");
    expect(legend[0].text).toBe("Tool 0 $10.00");
  });
});
```

- [x] **Step 2: Run the test and check it fails**

Run: `npx vitest run src/lib/notify/chart.test.ts`
Expected: FAIL. Cannot find module `./chart`.

- [x] **Step 3: Implement**

`src/lib/notify/chart.ts`:
```ts
import { formatUsd } from "@/lib/utils";
import type { ChartBucket, ToolAmount } from "./digest";

/** Rendered at 2× (Slack displays ~460px wide) so bars stay crisp on retina screens. */
export const CHART_W = 920;
export const CHART_H = 380;
export const CHART_PLOT = { left: 88, right: 900, top: 76, bottom: 296 } as const;
const LEGEND_MAX = 4;

export interface ChartSegment { y: number; h: number; color: string }
export interface ChartBar { x: number; w: number; label: string; current: boolean; segments: ChartSegment[]; totalLabel: string | null }
export interface ChartLayout {
  width: number;
  height: number;
  title: string;
  gridlines: { y: number; label: string }[];
  bars: ChartBar[];
  legend: { color: string; text: string }[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function niceMax(v: number): number {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function axisUsd(v: number): string {
  return v >= 1000 ? `$${(v / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k` : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * Pure geometry for one section's chart: stacked bars per bucket in
 * `chartTools` order (largest tool at the bottom), each section on its OWN
 * scale — which is why the title is drawn into the image.
 */
export function chartLayout(title: string, buckets: ChartBucket[], chartTools: ToolAmount[], legendTools: ToolAmount[]): ChartLayout {
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.totalUsd)));
  const plotH = CHART_PLOT.bottom - CHART_PLOT.top;
  const yOf = (usd: number) => CHART_PLOT.bottom - (usd / max) * plotH;
  const step = (CHART_PLOT.right - CHART_PLOT.left) / Math.max(1, buckets.length);
  const w = Math.max(4, Math.round(step * 0.66));

  const bars = buckets.map((b, i) => {
    let base = 0;
    const segments: ChartSegment[] = [];
    for (const t of chartTools) {
      const usd = b.byTool[t.key] ?? 0;
      if (usd <= 0) continue;
      const top = yOf(base + usd);
      segments.push({ y: r1(top), h: r1(yOf(base) - top), color: t.color });
      base += usd;
    }
    return {
      x: r1(CHART_PLOT.left + i * step + (step - w) / 2),
      w,
      label: b.label,
      current: b.current,
      segments,
      totalLabel: b.current ? formatUsd(b.totalUsd) : null,
    };
  });

  const legend = legendTools.slice(0, LEGEND_MAX).map((t) => ({ color: t.color, text: `${t.label} ${formatUsd(t.usd)}` }));
  if (legendTools.length > LEGEND_MAX) legend.push({ color: "#8b92a5", text: `+${legendTools.length - LEGEND_MAX} more` });

  return {
    width: CHART_W,
    height: CHART_H,
    title,
    gridlines: [0, max / 2, max].map((v) => ({ y: r1(yOf(v)), label: axisUsd(v) })),
    bars,
    legend,
  };
}
```

`src/lib/notify/chart-image.tsx`:
```tsx
import { ImageResponse } from "next/og";
import type { CSSProperties } from "react";
import { CHART_PLOT, type ChartLayout } from "./chart";

const abs = (s: CSSProperties): CSSProperties => ({ position: "absolute", display: "flex", ...s });

/**
 * ChartLayout → PNG via next/og (Satori). Satori is flexbox-only and needs
 * `display: flex` on any element with more than one child, so everything is
 * absolutely-positioned boxes. Earlier buckets are dimmed; the current one is
 * full-strength with its total above.
 */
export async function renderChartPng(layout: ChartLayout): Promise<Uint8Array<ArrayBuffer>> {
  const image = new ImageResponse(
    (
      <div style={{ width: layout.width, height: layout.height, display: "flex", position: "relative", backgroundColor: "#ffffff", fontFamily: "sans-serif" }}>
        <div style={abs({ left: 24, top: 18, fontSize: 21, letterSpacing: 1.2, color: "#616061" })}>{layout.title}</div>
        {layout.gridlines.map((g) => (
          <div key={`g${g.y}`} style={abs({ left: 0, top: g.y - 12, width: layout.width, height: 24, alignItems: "center" })}>
            <div style={{ width: CHART_PLOT.left - 12, display: "flex", justifyContent: "flex-end", paddingRight: 10, fontSize: 19, color: "#8a8a8a" }}>{g.label}</div>
            <div style={{ flexGrow: 1, height: 2, backgroundColor: "#ececec", marginRight: layout.width - CHART_PLOT.right }} />
          </div>
        ))}
        {layout.bars.flatMap((b, i) => [
          ...b.segments.map((s, j) => (
            <div key={`s${i}-${j}`} style={abs({ left: b.x, top: s.y, width: b.w, height: s.h, backgroundColor: s.color, opacity: b.current ? 1 : 0.45 })} />
          )),
          <div key={`l${i}`} style={abs({ left: b.x - 30, top: CHART_PLOT.bottom + 10, width: b.w + 60, justifyContent: "center", fontSize: 19, color: b.current ? "#1d1c1d" : "#8a8a8a" })}>{b.label}</div>,
          ...(b.totalLabel
            ? [<div key={`t${i}`} style={abs({ left: b.x - 60, top: (b.segments.at(-1)?.y ?? CHART_PLOT.bottom) - 30, width: b.w + 120, justifyContent: "center", fontSize: 21, color: "#1d1c1d" })}>{b.totalLabel}</div>]
            : []),
        ])}
        <div style={abs({ left: CHART_PLOT.left, top: CHART_PLOT.bottom + 46, alignItems: "center" })}>
          {layout.legend.map((e, i) => (
            <div key={`k${i}`} style={{ display: "flex", alignItems: "center", marginRight: 26 }}>
              <div style={{ width: 18, height: 18, borderRadius: 4, backgroundColor: e.color, marginRight: 8 }} />
              <div style={{ fontSize: 19, color: "#555555" }}>{e.text}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    { width: layout.width, height: layout.height },
  );
  return new Uint8Array(await image.arrayBuffer());
}
```

- [x] **Step 4: Run the test and check it passes**

Run: `npx vitest run src/lib/notify/chart.test.ts`
Expected: PASS. (`chart-image.tsx` is exercised by the build and by Task 13's visual check. Satori isn't run under vitest.)

- [x] **Step 5: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
Expected: the build type-checks `chart-image.tsx`. If TS rejects `Uint8Array<ArrayBuffer>` from `new Uint8Array(ArrayBuffer)`, keep the annotation and wrap as `new Uint8Array(await image.arrayBuffer()) as Uint8Array<ArrayBuffer>`.
```bash
git add src/lib/notify/chart.ts src/lib/notify/chart-image.tsx src/lib/notify/chart.test.ts
git commit -m "feat: digest chart layout + next/og PNG renderer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Block Kit renderer and mrkdwn parser

**Files:**
- Create: `src/lib/notify/render.ts`
- Create: `src/lib/notify/mrkdwn.ts`
- Test: `src/lib/notify/render.test.ts`, `src/lib/notify/mrkdwn.test.ts`

**Interfaces:**
- Consumes: `Digest`, `DigestSection`, `ReportsSection`, `ToolAmount` (Task 5); `CADENCE_UNIT`, `CHART_SPAN` (Task 3); `formatUsd`.
- Produces:
  - `type SlackBlock = Record<string, unknown>`, `interface ChartFileIds { you?: string; reports?: string }`, `interface RenderedDigest { blocks: SlackBlock[]; text: string }`
  - `escapeMrkdwn(s): string`, `deltaText(s: DigestSection, unit: string): string`, `chartTitle(section: "you" | "reports", d: Digest): string`
  - `renderDigest(d: Digest, files: ChartFileIds, opts?: { previewFor?: string }): RenderedDigest`
  - `type MrkNode = { t: "text"; v: string } | { t: "bold"; v: string } | { t: "link"; href: string; v: string } | { t: "br" }`, `parseMrkdwn(s: string): MrkNode[]`

- [x] **Step 1: Write the failing tests**

`src/lib/notify/render.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Digest, DigestSection } from "./digest";
import { chartTitle, deltaText, escapeMrkdwn, renderDigest } from "./render";
import { periodFor } from "./schedule";

const now = new Date("2026-09-30T07:00:00Z");
const sec = (over: Partial<DigestSection> = {}): DigestSection => ({
  basis: "usage", headlineUsd: 38.2, prevUsd: 34.1, deltaPct: 12, chart: [], chartTools: [],
  byTool: [{ key: "cursor", label: "Cursor", color: "#f59e0b", usd: 30.1 }, { key: "anthropic", label: "Anthropic API", color: "#d2845a", usd: 8.1 }],
  month: { monthLabel: "September", soFarUsd: 142, projectedUsd: 190, complete: false }, ...over,
});
const digest = (over: Partial<Digest> = {}): Digest => ({
  recipient: { employeeId: "m", name: "Priya Nair", team: "Engineering" },
  period: periodFor("weekly", "2026-W39", now),
  you: sec(),
  reports: {
    ...sec({ headlineUsd: 612, prevUsd: 640, deltaPct: -4.4, month: { monthLabel: "September", soFarUsd: 3410, projectedUsd: 4600, complete: false } }),
    headcount: 14,
    top: [
      { employeeId: "a", name: "Alex Kim", usd: 140, href: "https://x.test/explore/Engineering/a" },
      { employeeId: "t", name: "Tom & <Jerry>", usd: 96, href: "https://x.test/explore/Engineering/t" },
    ],
    othersCount: 9, othersUsd: 175,
  },
  caveats: ["⚠ Cursor data may be incomplete (last updated 26 Sep)"],
  dashboardUrl: "https://x.test/explore/Engineering/m",
  ...over,
});
const mrk = (b: Record<string, unknown>) => (b.text as { text: string }).text;

describe("renderDigest", () => {
  const { blocks, text } = renderDigest(digest(), { you: "F1", reports: "F2" });

  it("leads with a header naming the period", () => {
    expect(blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "📊 Your AI spend · 21–27 Sep 2026", emoji: true } });
  });

  it("renders the You section: headline, its own chart, tools + month line", () => {
    expect(mrk(blocks[1])).toBe("*YOU*\n*$38.20* usage · ▲ 12% vs previous week");
    expect(blocks[2]).toEqual({ type: "image", slack_file: { id: "F1" }, alt_text: "YOU · USAGE, LAST 8 WEEKS: $38.20" });
    expect(blocks[3]).toEqual({ type: "context", elements: [
      { type: "mrkdwn", text: "Cursor $30.10 · Anthropic API $8.10" },
      { type: "mrkdwn", text: "September so far $142 · on track for ~$190" },
    ] });
  });

  it("renders the reports section with escaped, linked names and others", () => {
    const i = blocks.findIndex((b) => b.type === "section" && mrk(b).startsWith("*YOUR REPORTS"));
    expect(mrk(blocks[i])).toBe("*YOUR REPORTS · 14 PEOPLE*\n*$612* usage · ▼ 4% vs previous week");
    expect(blocks[i + 1]).toMatchObject({ type: "image", slack_file: { id: "F2" } });
    expect(mrk(blocks[i + 2])).toBe(
      "<https://x.test/explore/Engineering/a|Alex Kim> $140 · <https://x.test/explore/Engineering/t|Tom &amp; &lt;Jerry&gt;> $96.00 · +9 others $175",
    );
  });

  it("ends with caveats and an Open in dashboard button", () => {
    expect(blocks.at(-2)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "⚠ Cursor data may be incomplete (last updated 26 Sep)" }] });
    expect(blocks.at(-1)).toMatchObject({ type: "actions", elements: [{ type: "button", url: "https://x.test/explore/Engineering/m" }] });
  });

  it("has a plain-text fallback carrying every headline figure", () => {
    expect(text).toContain("$38.20");
    expect(text).toContain("$612");
    expect(text).toContain("21–27 Sep 2026");
  });

  it("omits image blocks when no chart was uploaded", () => {
    expect(renderDigest(digest(), {}).blocks.some((b) => b.type === "image")).toBe(false);
  });

  it("prefixes preview messages with who it would have gone to", () => {
    const first = renderDigest(digest(), {}, { previewFor: "Priya Nair (weekly)" }).blocks[0];
    expect(first).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "🔍 Preview · would send to Priya Nair (weekly)" }] });
  });

  it("people without reports get no reports section", () => {
    const b = renderDigest(digest({ reports: null }), {}).blocks;
    expect(b.some((x) => x.type === "section" && mrk(x).includes("REPORTS"))).toBe(false);
  });
});

describe("deltaText", () => {
  it("covers up, down, flat, from-zero and nothing-at-all", () => {
    expect(deltaText(sec({ deltaPct: 12 }), "week")).toBe("▲ 12% vs previous week");
    expect(deltaText(sec({ deltaPct: -4.4 }), "week")).toBe("▼ 4% vs previous week");
    expect(deltaText(sec({ deltaPct: 0.3 }), "day")).toBe("no change vs previous day");
    expect(deltaText(sec({ deltaPct: null, prevUsd: 0, headlineUsd: 5 }), "month")).toBe("up from $0 the previous month");
    expect(deltaText(sec({ deltaPct: null, prevUsd: 0, headlineUsd: 0 }), "week")).toBe("no spend");
  });
});

describe("chartTitle", () => {
  it("names the section, basis and span", () => {
    expect(chartTitle("you", digest())).toBe("YOU · USAGE, LAST 8 WEEKS");
    expect(chartTitle("reports", digest())).toBe("YOUR REPORTS (14 PEOPLE) · USAGE, LAST 8 WEEKS");
    const monthly = digest({ period: periodFor("monthly", "2026-08", now), you: sec({ basis: "total", month: null }) });
    expect(chartTitle("you", monthly)).toBe("YOU · TOTAL, LAST 6 MONTHS");
  });
});

describe("escapeMrkdwn", () => {
  it("escapes the three characters Slack treats as control", () => {
    expect(escapeMrkdwn("Tom & <Jerry>")).toBe("Tom &amp; &lt;Jerry&gt;");
  });
});
```

`src/lib/notify/mrkdwn.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseMrkdwn } from "./mrkdwn";

describe("parseMrkdwn", () => {
  it("parses bold, line breaks and plain text", () => {
    expect(parseMrkdwn("*YOU*\n*$38.20* usage")).toEqual([
      { t: "bold", v: "YOU" }, { t: "br" }, { t: "bold", v: "$38.20" }, { t: "text", v: " usage" },
    ]);
  });
  it("parses links and decodes entities in their text", () => {
    expect(parseMrkdwn("<https://x.test/a|Tom &amp; &lt;Jerry&gt;> $96")).toEqual([
      { t: "link", href: "https://x.test/a", v: "Tom & <Jerry>" }, { t: "text", v: " $96" },
    ]);
  });
});
```

- [x] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/notify/render.test.ts src/lib/notify/mrkdwn.test.ts`
Expected: FAIL. Cannot find module `./render` / `./mrkdwn`.

- [x] **Step 3: Implement**

`src/lib/notify/render.ts`:
```ts
import { formatUsd } from "@/lib/utils";
import type { Digest, DigestSection, ReportsSection, ToolAmount } from "./digest";
import { CADENCE_UNIT, CHART_SPAN } from "./schedule";

export type SlackBlock = Record<string, unknown>;
/** Slack file ids of the uploaded charts (absent = send without that image). */
export interface ChartFileIds { you?: string; reports?: string }
export interface RenderedDigest { blocks: SlackBlock[]; text: string }

const TOOLS_MAX = 4;
const CONTEXT_MAX = 10; // Slack's element cap per context block

/** Slack mrkdwn treats &, < and > as control characters — escape every user-supplied string. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function deltaText(s: DigestSection, unit: string): string {
  if (s.deltaPct === null) return s.headlineUsd > 0 ? `up from $0 the previous ${unit}` : "no spend";
  if (Math.abs(s.deltaPct) < 0.5) return `no change vs previous ${unit}`;
  return `${s.deltaPct > 0 ? "▲" : "▼"} ${Math.round(Math.abs(s.deltaPct)).toLocaleString("en-US")}% vs previous ${unit}`;
}

const people = (n: number) => `${n} ${n === 1 ? "PERSON" : "PEOPLE"}`;

export function chartTitle(section: "you" | "reports", d: Digest): string {
  const s = section === "you" ? d.you : d.reports!;
  const who = section === "you" ? "YOU" : `YOUR REPORTS (${people(d.reports!.headcount)})`;
  const c = d.period.cadence;
  return `${who} · ${s.basis.toUpperCase()}, LAST ${CHART_SPAN[c]} ${CADENCE_UNIT[c].toUpperCase()}S`;
}

function toolsLine(tools: ToolAmount[]): string | null {
  if (!tools.length) return null;
  const shown = tools.slice(0, TOOLS_MAX).map((t) => `${escapeMrkdwn(t.label)} ${formatUsd(t.usd)}`);
  const rest = tools.slice(TOOLS_MAX);
  if (rest.length) shown.push(`+${rest.length} more ${formatUsd(rest.reduce((s, t) => s + t.usd, 0))}`);
  return shown.join(" · ");
}

function monthLine(s: DigestSection): string | null {
  const m = s.month;
  if (!m) return null;
  if (m.complete) return `${m.monthLabel} total ${formatUsd(m.soFarUsd)}`;
  return `${m.monthLabel} so far ${formatUsd(m.soFarUsd)}${m.projectedUsd !== null ? ` · on track for ~${formatUsd(m.projectedUsd)}` : ""}`;
}

const context = (lines: string[]): SlackBlock => ({
  type: "context",
  elements: lines.slice(0, CONTEXT_MAX).map((text) => ({ type: "mrkdwn", text })),
});

function topLine(r: ReportsSection, unit: string): string {
  if (!r.top.length) return `No usage from your reports this ${unit}`;
  const names = r.top.map((p) => `<${p.href}|${escapeMrkdwn(p.name)}> ${formatUsd(p.usd)}`);
  if (r.othersCount) names.push(`+${r.othersCount} others ${formatUsd(r.othersUsd)}`);
  return names.join(" · ");
}

function sectionBlocks(label: string, s: DigestSection, fileId: string | undefined, title: string, unit: string, extra?: string): SlackBlock[] {
  const out: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${label}*\n*${formatUsd(s.headlineUsd)}* ${s.basis} · ${deltaText(s, unit)}` } },
  ];
  if (fileId) out.push({ type: "image", slack_file: { id: fileId }, alt_text: `${title}: ${formatUsd(s.headlineUsd)}` });
  if (extra) out.push({ type: "section", text: { type: "mrkdwn", text: extra } });
  const lines = [toolsLine(s.byTool), monthLine(s)].filter((l): l is string => l !== null);
  if (lines.length) out.push(context(lines));
  return out;
}

/** Digest → Block Kit. The admin preview renders these same blocks (block-kit-preview.tsx). */
export function renderDigest(d: Digest, files: ChartFileIds, opts: { previewFor?: string } = {}): RenderedDigest {
  const unit = CADENCE_UNIT[d.period.cadence];
  const blocks: SlackBlock[] = [];
  if (opts.previewFor) blocks.push(context([`🔍 Preview · would send to ${escapeMrkdwn(opts.previewFor)}`]));
  blocks.push({ type: "header", text: { type: "plain_text", text: `📊 Your AI spend · ${d.period.label}`, emoji: true } });
  blocks.push(...sectionBlocks("YOU", d.you, files.you, chartTitle("you", d), unit));
  if (d.reports) {
    blocks.push({ type: "divider" });
    blocks.push(...sectionBlocks(`YOUR REPORTS · ${people(d.reports.headcount)}`, d.reports, files.reports, chartTitle("reports", d), unit, topLine(d.reports, unit)));
  }
  if (d.caveats.length) blocks.push(context(d.caveats.map(escapeMrkdwn)));
  blocks.push({
    type: "actions",
    elements: [{ type: "button", text: { type: "plain_text", text: "Open in dashboard" }, url: d.dashboardUrl, action_id: "open_dashboard" }],
  });

  const text =
    `Your AI spend · ${d.period.label}: you ${formatUsd(d.you.headlineUsd)} ${d.you.basis}` +
    (d.reports ? ` · your reports ${formatUsd(d.reports.headlineUsd)} ${d.reports.basis}` : "");
  return { blocks, text: opts.previewFor ? `[Preview for ${opts.previewFor}] ${text}` : text };
}
```

`src/lib/notify/mrkdwn.ts`:
```ts
/** The mrkdwn subset renderDigest emits: *bold*, <url|text> links and line breaks. */
export type MrkNode = { t: "text"; v: string } | { t: "bold"; v: string } | { t: "link"; href: string; v: string } | { t: "br" };

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const TOKEN = /<([^|>]+)\|([^>]+)>|\*([^*\n]+)\*|\n/g;

/** Parsed into nodes (not HTML) so the preview renders through React's own escaping. */
export function parseMrkdwn(s: string): MrkNode[] {
  const out: MrkNode[] = [];
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", v: decode(s.slice(last, at)) });
    if (m[1] !== undefined) out.push({ t: "link", href: m[1], v: decode(m[2]) });
    else if (m[3] !== undefined) out.push({ t: "bold", v: decode(m[3]) });
    else out.push({ t: "br" });
    last = at + m[0].length;
  }
  if (last < s.length) out.push({ t: "text", v: decode(s.slice(last)) });
  return out;
}
```

- [x] **Step 4: Run the tests and check they pass**

Run: `npx vitest run src/lib/notify/render.test.ts src/lib/notify/mrkdwn.test.ts`
Expected: PASS

- [x] **Step 5: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
```bash
git add src/lib/notify/render.ts src/lib/notify/render.test.ts src/lib/notify/mrkdwn.ts src/lib/notify/mrkdwn.test.ts
git commit -m "feat: Block Kit digest renderer with escaped names + mrkdwn parser

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Slack client, app manifest and the image check

**Files:**
- Create: `src/lib/notify/slack-client.ts`
- Create: `docs/slack-app-manifest.yml`
- Create: `scripts/slack-smoke.ts`
- Modify: `.env.example`
- Test: `src/lib/notify/slack-client.test.ts`

**Interfaces:**
- Produces:
  - `interface SlackClient { lookupUserByEmail(email: string): Promise<string | null>; openDm(userId: string): Promise<string>; uploadImage(png: Uint8Array<ArrayBuffer>, filename: string, title: string): Promise<string>; postMessage(channel: string, blocks: unknown[], text: string): Promise<string> }`
  - `class SlackApiError extends Error { method: string; code: string }`
  - `createSlackClient(token: string, opts?: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): SlackClient`

- [x] **Step 1: Write the failing test.** `src/lib/notify/slack-client.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createSlackClient, SlackApiError } from "./slack-client";

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (Response | ((c: Call) => Response))[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${c.url}`);
    return typeof next === "function" ? next(c) : next;
  }) as typeof fetch;
  return { fn, calls };
}
const ok = (body: object) => new Response(JSON.stringify({ ok: true, ...body }), { status: 200 });
const fail = (error: string) => new Response(JSON.stringify({ ok: false, error }), { status: 200 });
const form = (c: Call) => new URLSearchParams(String(c.init.body));

describe("createSlackClient", () => {
  it("looks users up by email; users_not_found is null, not an error", async () => {
    const f = fakeFetch([ok({ user: { id: "U1" } }), fail("users_not_found")]);
    const slack = createSlackClient("xoxb-t", { fetch: f.fn });
    expect(await slack.lookupUserByEmail("a@x.com")).toBe("U1");
    expect(await slack.lookupUserByEmail("b@x.com")).toBeNull();
    expect(f.calls[0].url).toBe("https://slack.com/api/users.lookupByEmail");
    expect(form(f.calls[0]).get("email")).toBe("a@x.com");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-t");
  });

  it("throws SlackApiError with the Slack error code", async () => {
    const slack = createSlackClient("t", { fetch: fakeFetch([fail("channel_not_found")]).fn });
    await expect(slack.openDm("U1")).rejects.toMatchObject({ name: "SlackApiError", method: "conversations.open", code: "channel_not_found" });
  });

  it("waits Retry-After on 429 and retries, up to 3 times", async () => {
    const slept: number[] = [];
    const limited = () => new Response("", { status: 429, headers: { "retry-after": "2" } });
    const f = fakeFetch([limited(), ok({ channel: { id: "D1" } })]);
    const slack = createSlackClient("t", { fetch: f.fn, sleep: async (ms) => void slept.push(ms) });
    expect(await slack.openDm("U1")).toBe("D1");
    expect(slept).toEqual([2000]);

    const g = fakeFetch([limited(), limited(), limited(), limited()]);
    const s2 = createSlackClient("t", { fetch: g.fn, sleep: async () => {} });
    await expect(s2.openDm("U1")).rejects.toMatchObject({ code: "http_429" });
  });

  it("uploads an image in three steps and returns the file id", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const f = fakeFetch([
      ok({ upload_url: "https://files.slack.com/upload/abc", file_id: "F1" }),
      new Response("OK", { status: 200 }),
      ok({ files: [{ id: "F1" }] }),
    ]);
    const slack = createSlackClient("t", { fetch: f.fn });
    expect(await slack.uploadImage(png, "you.png", "YOU · USAGE")).toBe("F1");
    expect(form(f.calls[0]).get("length")).toBe("4");
    expect(f.calls[1].url).toBe("https://files.slack.com/upload/abc");
    expect(f.calls[1].init.body).toBe(png);
    expect(JSON.parse(form(f.calls[2]).get("files")!)).toEqual([{ id: "F1", title: "YOU · USAGE" }]);
  });

  it("posts blocks as JSON with unfurls off and returns the ts", async () => {
    const f = fakeFetch([ok({ ts: "1727.1" })]);
    const slack = createSlackClient("t", { fetch: f.fn });
    expect(await slack.postMessage("D1", [{ type: "divider" }], "hi")).toBe("1727.1");
    const p = form(f.calls[0]);
    expect([p.get("channel"), p.get("text"), p.get("blocks"), p.get("unfurl_links")]).toEqual(["D1", "hi", '[{"type":"divider"}]', "false"]);
  });

  it("is an Error subclass callers can branch on", () => {
    expect(new SlackApiError("chat.postMessage", "invalid_blocks")).toBeInstanceOf(Error);
  });
});
```

- [x] **Step 2: Run the test and check it fails**

Run: `npx vitest run src/lib/notify/slack-client.test.ts`
Expected: FAIL. Cannot find module `./slack-client`.

- [x] **Step 3: Implement**

`src/lib/notify/slack-client.ts`:
```ts
/**
 * Minimal Slack Web API client over fetch (no SDK dependency). The token is
 * injected — only src/lib/notify/wiring.ts (server-only) reads it from env —
 * so this module stays unit-testable. Every method is form-encoded, which
 * Slack accepts for all Web API calls (complex args as JSON strings).
 */
export interface SlackClient {
  lookupUserByEmail(email: string): Promise<string | null>;
  openDm(userId: string): Promise<string>;
  uploadImage(png: Uint8Array<ArrayBuffer>, filename: string, title: string): Promise<string>;
  postMessage(channel: string, blocks: unknown[], text: string): Promise<string>;
}

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string) {
    super(`Slack ${method}: ${code}`);
    this.name = "SlackApiError";
  }
}

const API = "https://slack.com/api/";
const MAX_RETRIES = 3;

export function createSlackClient(
  token: string,
  opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): SlackClient {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call<T>(method: string, params: Record<string, string>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${API}${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: new URLSearchParams(params).toString(),
      });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep((Number(res.headers.get("retry-after")) || 1) * 1000);
        continue;
      }
      if (!res.ok) throw new SlackApiError(method, `http_${res.status}`);
      const json = (await res.json()) as { ok: boolean; error?: string } & T;
      if (!json.ok) throw new SlackApiError(method, json.error ?? "unknown_error");
      return json;
    }
  }

  return {
    async lookupUserByEmail(email) {
      try {
        return (await call<{ user: { id: string } }>("users.lookupByEmail", { email })).user.id;
      } catch (err) {
        if (err instanceof SlackApiError && err.code === "users_not_found") return null;
        throw err;
      }
    },
    async openDm(userId) {
      return (await call<{ channel: { id: string } }>("conversations.open", { users: userId })).channel.id;
    },
    async uploadImage(png, filename, title) {
      const { upload_url, file_id } = await call<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", {
        filename,
        length: String(png.byteLength),
      });
      const up = await f(upload_url, { method: "POST", body: png });
      if (!up.ok) throw new SlackApiError("files.upload", `http_${up.status}`);
      // No channel_id: the file stays private to the app until a message references it.
      await call("files.completeUploadExternal", { files: JSON.stringify([{ id: file_id, title }]) });
      return file_id;
    },
    async postMessage(channel, blocks, text) {
      return (
        await call<{ ts: string }>("chat.postMessage", {
          channel,
          text,
          blocks: JSON.stringify(blocks),
          unfurl_links: "false",
          unfurl_media: "false",
        })
      ).ts;
    },
  };
}
```

`docs/slack-app-manifest.yml`:
```yaml
# Slack app for AI spend digests. Create at https://api.slack.com/apps →
# "Create New App" → "From an app manifest" → paste this → Install to
# workspace → copy the Bot User OAuth Token (xoxb-…) into Vercel env as
# SLACK_BOT_TOKEN (sensitive). Scopes are the minimum the digests need.
display_information:
  name: AI Spend
  description: Your AI tool spend, from the Intent HQ AI costs dashboard.
  background_color: "#1d4ed8"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: true
  bot_user:
    display_name: AI Spend
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:write
      - users:read
      - users:read.email
      - files:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

`scripts/slack-smoke.ts`:
```ts
/**
 * Slack smoke test / the step-0 private-image check (spec §10.2).
 *
 * Uploads a small PNG privately (no channel), then DMs SLACK_PREVIEW_EMAIL a
 * message whose image block references it by slack_file id — the exact
 * shape renderDigest emits. Look in Slack: the orange bars must render
 * INSIDE the message, under the text.
 *
 * Run: npx tsx scripts/slack-smoke.ts   (reads SLACK_BOT_TOKEN + SLACK_PREVIEW_EMAIL from .env.local)
 */
import { createSlackClient, SlackApiError } from "@/lib/notify/slack-client";
import { makeTestPng } from "@/scripts/slack-smoke"; // or copy makeTestPng inline

process.loadEnvFile(".env.local");

// Test PNG is generated at runtime (see makeTestPng in scripts/slack-smoke.ts) — never embed a hand-copied base64 blob.


async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  const email = process.env.SLACK_PREVIEW_EMAIL;
  if (!token || !email) throw new Error("Set SLACK_BOT_TOKEN and SLACK_PREVIEW_EMAIL in .env.local");
  const slack = createSlackClient(token);

  const userId = await slack.lookupUserByEmail(email);
  if (!userId) throw new Error(`No Slack user for ${email}`);
  const png = makeTestPng();
  const fileId = await slack.uploadImage(png, "smoke.png", "SMOKE TEST CHART");
  const channel = await slack.openDm(userId);
  const ts = await slack.postMessage(
    channel,
    [
      { type: "section", text: { type: "mrkdwn", text: "*AI Spend smoke test*\nThe chart below should render inside this message." } },
      { type: "image", slack_file: { id: fileId }, alt_text: "smoke test chart" },
    ],
    "AI Spend smoke test",
  );
  console.log(`OK — posted ts=${ts} with file ${fileId}. Check the DM from AI Spend.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Append to `.env.example`:
```
# Slack spend digests (see docs/slack-app-manifest.yml). Mode: off | preview | live (unset = off).
SLACK_BOT_TOKEN=
SLACK_NOTIFY_MODE=off
SLACK_PREVIEW_EMAIL=
# Optional: base URL for dashboard links (defaults to https://$VERCEL_PROJECT_PRODUCTION_URL).
APP_BASE_URL=
```

- [x] **Step 4: Run the test and check it passes**

Run: `npx vitest run src/lib/notify/slack-client.test.ts`
Expected: PASS

- [x] **Step 5: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
```bash
git add src/lib/notify/slack-client.ts src/lib/notify/slack-client.test.ts docs/slack-app-manifest.yml scripts/slack-smoke.ts .env.example
git commit -m "feat: Slack Web API client, app manifest and smoke script

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### ⏸ Checkpoint B: Slack private-image check (Gareth)

1. Gareth creates the Slack app from `docs/slack-app-manifest.yml`, installs it, and adds `SLACK_BOT_TOKEN` and `SLACK_PREVIEW_EMAIL` to `.env.local` (and later to Vercel).
2. Run `npx tsx scripts/slack-smoke.ts`.
3. **Pass:** the orange bars render inside the DM. Continue.
4. **Fail** (an `invalid_blocks` error, or the image missing or "not available"): apply the spec's fallback before Task 10. In `slack-client.ts` `uploadImage`, add a `channelId` parameter and pass `channel_id` to `files.completeUploadExternal` (the file then posts into the DM). In `deliver.ts` (Task 10), upload the charts **after** the text message, into the same DM channel, and call `renderDigest(digest, {})` so no image blocks are emitted. Record the decision in the spec's §10.

---

### Task 9: Store, memory store and context

**Files:**
- Create: `src/lib/notify/store.ts`
- Create: `src/lib/notify/memory-store.ts`
- Create: `src/lib/notify/context.ts`
- Test: `src/lib/notify/store.test.ts`, `src/lib/notify/context.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5; `fetchEmployeesAll`, `fetchFactsInRange` (`src/lib/queries/common.ts`); `getSourceHorizons`, `getToolColors` (`src/lib/queries/explore.ts`); `getImportCoverageScope`, `buildImportCoverage`, `CoverageMonthRow` (`src/lib/queries/import-coverage.ts`).
- Produces:
  - `interface SendKey { employeeId: string; cadence: Cadence; periodKey: string; mode: SendMode }`
  - `interface SendResult { status: "sent" | "skipped" | "failed"; slackTs?: string; detail?: string }`
  - `interface NotifyStore { subscriptions(cadences: Cadence[]): Promise<{ employeeId: string; cadence: Cadence }[]>; employees(): Promise<NotifyEmployee[]>; facts(from: string, toExclusive: string): Promise<ShapeFact[]>; sourceHorizons(): Promise<Record<string, string>>; usageHorizons(): Promise<Record<string, string>>; toolColors(): Promise<Record<string, string>>; recentSyncRuns(sinceIso: string): Promise<SyncRunRow[]>; importCoverage(nowMonth: string): Promise<CoverageMonthRow[]>; claimSend(key: SendKey): Promise<boolean>; finishSend(key: SendKey, r: SendResult): Promise<void>; expireStalePending(olderThanIso: string): Promise<number>; slackUser(employeeId: string): Promise<{ slackUserId: string | null; lookedUpAt: string } | null>; saveSlackUser(employeeId: string, slackUserId: string | null): Promise<void> }`
  - `MAX_SEND_ATTEMPTS = 3`, `canRetakeClaim(existing: { status: string; attempts: number }): boolean`, `pageAll<T>(...)`, `supabaseNotifyStore(supabase: SupabaseClient): NotifyStore`
  - `interface SendRow extends SendKey { status: string; attempts: number; slackTs: string | null; detail: string | null; updatedAt: string }`, `memoryStore(seed, clock?): NotifyStore & { sends: SendRow[]; slackUserCache: Map<...>; factCalls: [string, string][]; failNextFinish: boolean }`
  - `interface NotifyContext { now: Date; baseUrl: string; employees: NotifyEmployee[]; employeesById: Map<string, NotifyEmployee>; tree: ReportingTree; facts: ShapeFact[]; sourceHorizons: Record<string, string>; toolColors: Record<string, string>; freshness: SourceFreshness[]; coverage: CoverageMonthRow[]; syncRuns: SyncRunRow[] }`
  - `HISTORY_MONTHS = 7`, `factsWindow(now, earliest?)`, `syncRunsSince(now): string`, `loadNotifyContext(store, now, baseUrl, opts?: { earliest?: string; coverage?: CoverageMonthRow[]; syncRuns?: SyncRunRow[] }): Promise<NotifyContext>`, `digestFor(ctx, employeeId, period): Digest | null`

- [x] **Step 1: Write the failing tests**

`src/lib/notify/store.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { canRetakeClaim, MAX_SEND_ATTEMPTS } from "./store";

describe("canRetakeClaim", () => {
  it("only retakes FAILED rows that still have attempts left", () => {
    expect(canRetakeClaim({ status: "failed", attempts: 1 })).toBe(true);
    expect(canRetakeClaim({ status: "failed", attempts: MAX_SEND_ATTEMPTS })).toBe(false);
    for (const status of ["sent", "skipped", "pending"]) expect(canRetakeClaim({ status, attempts: 1 })).toBe(false);
  });
});
```

`src/lib/notify/context.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import { digestFor, factsWindow, loadNotifyContext } from "./context";
import { memoryStore } from "./memory-store";
import { periodFor } from "./schedule";
import type { NotifyEmployee } from "./types";

const now = new Date("2026-09-30T07:00:00Z");
const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: id, department: "Eng", oktaId: `00u${id}`, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
const fact = (day: string, usd: number, employeeId: string): ShapeFact => ({
  day, source: "cursor", costType: "overage", costUsd: usd, employeeId, department: "Eng", fullName: null, entityKey: employeeId, model: "",
});

describe("factsWindow", () => {
  it("covers 7 months of history for projections/charts, through tomorrow", () => {
    expect(factsWindow(now)).toEqual({ from: "2026-02-01", toExclusive: "2026-10-01" });
    expect(factsWindow(now, "2025-12-01").from).toBe("2025-12-01");
    expect(factsWindow(now, "2026-06-01").from).toBe("2026-02-01");
  });
});

describe("loadNotifyContext / digestFor", () => {
  const store = memoryStore({
    employees: [emp("m"), emp("a", { managerRef: "00um" })],
    facts: [fact("2026-09-22", 10, "m"), fact("2026-09-23", 25, "a")],
  });

  it("reads facts once for the window and builds the tree", async () => {
    const ctx = await loadNotifyContext(store, now, "https://x.test");
    expect(store.factCalls).toEqual([["2026-02-01", "2026-10-01"]]);
    expect(ctx.tree.reportsOf("m")).toEqual(["a"]);
  });

  it("builds a manager digest from the tree, and null for unknown people", async () => {
    const ctx = await loadNotifyContext(store, now, "https://x.test");
    const d = digestFor(ctx, "m", periodFor("weekly", "2026-W39", now))!;
    expect(d.you.headlineUsd).toBe(10);
    expect(d.reports!.headlineUsd).toBe(25);
    expect(digestFor(ctx, "nobody", periodFor("weekly", "2026-W39", now))).toBeNull();
  });
});
```

- [x] **Step 2: Run the tests and check they fail**

Run: `npx vitest run src/lib/notify/store.test.ts src/lib/notify/context.test.ts`
Expected: FAIL. Modules not found.

- [x] **Step 3: Implement**

`src/lib/notify/store.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShapeFact } from "@/lib/explore/shape";
import { fetchEmployeesAll, fetchFactsInRange } from "@/lib/queries/common";
import { getSourceHorizons, getToolColors } from "@/lib/queries/explore";
import { buildImportCoverage, getImportCoverageScope, type CoverageMonthRow } from "@/lib/queries/import-coverage";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import type { SyncRunRow } from "./freshness";
import { NOTIFY_EMPLOYEE_COLUMNS, toNotifyEmployee, type Cadence, type NotifyEmployee, type SendMode } from "./types";

export interface SendKey {
  employeeId: string;
  cadence: Cadence;
  periodKey: string;
  mode: SendMode;
}

export interface SendResult {
  status: "sent" | "skipped" | "failed";
  slackTs?: string;
  detail?: string; // never names or amounts
}

/** Everything runNotify / the admin preview need from the database — injectable for tests (memory-store.ts). */
export interface NotifyStore {
  subscriptions(cadences: Cadence[]): Promise<{ employeeId: string; cadence: Cadence }[]>;
  employees(): Promise<NotifyEmployee[]>;
  facts(from: string, toExclusive: string): Promise<ShapeFact[]>;
  sourceHorizons(): Promise<Record<string, string>>;
  usageHorizons(): Promise<Record<string, string>>;
  toolColors(): Promise<Record<string, string>>;
  recentSyncRuns(sinceIso: string): Promise<SyncRunRow[]>;
  importCoverage(nowMonth: string): Promise<CoverageMonthRow[]>;
  /** Insert a pending row; true = this run owns the send. */
  claimSend(key: SendKey): Promise<boolean>;
  finishSend(key: SendKey, r: SendResult): Promise<void>;
  /** Pending rows older than the cutoff → failed "interrupted", never retried. Returns how many. */
  expireStalePending(olderThanIso: string): Promise<number>;
  slackUser(employeeId: string): Promise<{ slackUserId: string | null; lookedUpAt: string } | null>;
  saveSlackUser(employeeId: string, slackUserId: string | null): Promise<void>;
}

export const MAX_SEND_ATTEMPTS = 3;

/**
 * A claim conflict may be taken over only when the earlier attempt FAILED
 * before posting and has attempts left. Interrupted rows are stamped with
 * MAX_SEND_ATTEMPTS, so they never qualify — we can't know whether that DM
 * went out, and never-twice beats always-once.
 */
export function canRetakeClaim(existing: { status: string; attempts: number }): boolean {
  return existing.status === "failed" && existing.attempts < MAX_SEND_ATTEMPTS;
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Page past PostgREST's 1000-row cap (gotcha #1). The query MUST order by a unique key. */
export async function pageAll<T>(query: (from: number, to: number) => PageResult<T>, label: string): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

const keyMatch = (k: SendKey) => ({ employee_id: k.employeeId, cadence: k.cadence, period_key: k.periodKey, mode: k.mode });

export function supabaseNotifyStore(supabase: SupabaseClient): NotifyStore {
  return {
    async subscriptions(cadences) {
      const rows = await pageAll<{ employee_id: string; cadence: Cadence }>(
        (a, b) => supabase.from("notification_subscriptions").select("employee_id, cadence").in("cadence", cadences).order("employee_id").order("cadence").range(a, b),
        "subscriptions",
      );
      return rows.map((r) => ({ employeeId: r.employee_id, cadence: r.cadence }));
    },
    async employees() {
      return (await fetchEmployeesAll(supabase, NOTIFY_EMPLOYEE_COLUMNS)).map(toNotifyEmployee);
    },
    async facts(from, toExclusive) {
      return fetchFactsInRange(supabase, from, toExclusive);
    },
    sourceHorizons: () => getSourceHorizons(supabase),
    async usageHorizons() {
      const out: Record<string, string> = {};
      await Promise.all(
        (Object.keys(VENDOR_LABEL) as Vendor[]).map(async (v) => {
          const { data, error } = await supabase
            .from("spend_facts")
            .select("day")
            .eq("source", v)
            .in("cost_type", ["overage", "metered"])
            .order("day", { ascending: false })
            .limit(1);
          if (error) throw new Error(`usageHorizons(${v}): ${error.message}`);
          if (data?.[0]?.day) out[v] = data[0].day as string;
        }),
      );
      return out;
    },
    toolColors: () => getToolColors(supabase),
    async recentSyncRuns(sinceIso) {
      const rows = await pageAll<{ source: string; status: string; started_at: string }>(
        (a, b) => supabase.from("sync_runs").select("source, status, started_at").gte("started_at", sinceIso).order("started_at", { ascending: false }).order("id").range(a, b),
        "recentSyncRuns",
      );
      return rows.map((r) => ({ source: r.source, status: r.status, startedAt: r.started_at }));
    },
    async importCoverage(nowMonth) {
      const scope = await getImportCoverageScope(supabase);
      return buildImportCoverage(scope.facts, scope.imports, nowMonth);
    },
    async claimSend(key) {
      const { error } = await supabase.from("notification_sends").insert({ ...keyMatch(key), status: "pending" });
      if (!error) return true;
      if (error.code !== "23505") throw new Error(`claimSend: ${error.message}`);
      const { data: existing, error: readErr } = await supabase.from("notification_sends").select("status, attempts").match(keyMatch(key)).single();
      if (readErr) throw new Error(`claimSend(read): ${readErr.message}`);
      if (!canRetakeClaim(existing as { status: string; attempts: number })) return false;
      // Optimistic takeover: only succeeds if nobody else retook it first.
      const { data: taken, error: takeErr } = await supabase
        .from("notification_sends")
        .update({ status: "pending", attempts: (existing.attempts as number) + 1, detail: null, updated_at: new Date().toISOString() })
        .match({ ...keyMatch(key), status: "failed", attempts: existing.attempts })
        .select("id");
      if (takeErr) throw new Error(`claimSend(retake): ${takeErr.message}`);
      return (taken?.length ?? 0) === 1;
    },
    async finishSend(key, r) {
      const { error } = await supabase
        .from("notification_sends")
        .update({ status: r.status, slack_ts: r.slackTs ?? null, detail: r.detail ?? null, updated_at: new Date().toISOString() })
        .match(keyMatch(key));
      if (error) throw new Error(`finishSend: ${error.message}`);
    },
    async expireStalePending(olderThanIso) {
      const { data, error } = await supabase
        .from("notification_sends")
        .update({ status: "failed", detail: "interrupted", attempts: MAX_SEND_ATTEMPTS, updated_at: new Date().toISOString() })
        .eq("status", "pending")
        .lt("updated_at", olderThanIso)
        .select("id");
      if (error) throw new Error(`expireStalePending: ${error.message}`);
      return data?.length ?? 0;
    },
    async slackUser(employeeId) {
      const { data, error } = await supabase.from("slack_users").select("slack_user_id, looked_up_at").eq("employee_id", employeeId).maybeSingle();
      if (error) throw new Error(`slackUser: ${error.message}`);
      return data ? { slackUserId: (data.slack_user_id as string | null) ?? null, lookedUpAt: data.looked_up_at as string } : null;
    },
    async saveSlackUser(employeeId, slackUserId) {
      const { error } = await supabase
        .from("slack_users")
        .upsert({ employee_id: employeeId, slack_user_id: slackUserId, looked_up_at: new Date().toISOString() }, { onConflict: "employee_id" });
      if (error) throw new Error(`saveSlackUser: ${error.message}`);
    },
  };
}
```

`src/lib/notify/memory-store.ts`:
```ts
import type { ShapeFact } from "@/lib/explore/shape";
import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import type { SyncRunRow } from "./freshness";
import { canRetakeClaim, MAX_SEND_ATTEMPTS, type NotifyStore, type SendKey } from "./store";
import type { Cadence, NotifyEmployee } from "./types";

/** In-memory NotifyStore for unit tests. Claim semantics share canRetakeClaim with the Supabase store. */
export interface SendRow extends SendKey {
  status: string;
  attempts: number;
  slackTs: string | null;
  detail: string | null;
  updatedAt: string;
}

export interface MemorySeed {
  employees?: NotifyEmployee[];
  facts?: ShapeFact[];
  subscriptions?: { employeeId: string; cadence: Cadence }[];
  syncRuns?: SyncRunRow[];
  coverage?: CoverageMonthRow[];
  sourceHorizons?: Record<string, string>;
  usageHorizons?: Record<string, string>;
  sends?: SendRow[];
}

const same = (a: SendKey, b: SendKey) =>
  a.employeeId === b.employeeId && a.cadence === b.cadence && a.periodKey === b.periodKey && a.mode === b.mode;

export function memoryStore(seed: MemorySeed = {}, clock: () => number = Date.now) {
  const sends: SendRow[] = [...(seed.sends ?? [])];
  const slackUserCache = new Map<string, { slackUserId: string | null; lookedUpAt: string }>();
  const factCalls: [string, string][] = [];
  const nowIso = () => new Date(clock()).toISOString();

  const store: NotifyStore & {
    sends: SendRow[];
    slackUserCache: typeof slackUserCache;
    factCalls: typeof factCalls;
    failNextFinish: boolean;
  } = {
    sends,
    slackUserCache,
    factCalls,
    failNextFinish: false,
    async subscriptions(cadences) {
      return (seed.subscriptions ?? []).filter((s) => cadences.includes(s.cadence));
    },
    async employees() {
      return seed.employees ?? [];
    },
    async facts(from, toExclusive) {
      factCalls.push([from, toExclusive]);
      return (seed.facts ?? []).filter((f) => f.day >= from && f.day < toExclusive);
    },
    sourceHorizons: async () => seed.sourceHorizons ?? {},
    usageHorizons: async () => seed.usageHorizons ?? {},
    toolColors: async () => ({}),
    recentSyncRuns: async (since) => (seed.syncRuns ?? []).filter((r) => r.startedAt >= since),
    importCoverage: async () => seed.coverage ?? [],
    async claimSend(key) {
      const existing = sends.find((s) => same(s, key));
      if (!existing) {
        sends.push({ ...key, status: "pending", attempts: 1, slackTs: null, detail: null, updatedAt: nowIso() });
        return true;
      }
      if (!canRetakeClaim(existing)) return false;
      Object.assign(existing, { status: "pending", attempts: existing.attempts + 1, detail: null, updatedAt: nowIso() });
      return true;
    },
    async finishSend(key, r) {
      if (store.failNextFinish) {
        store.failNextFinish = false;
        throw new Error("finishSend: simulated DB outage");
      }
      const row = sends.find((s) => same(s, key));
      if (row) Object.assign(row, { status: r.status, slackTs: r.slackTs ?? null, detail: r.detail ?? null, updatedAt: nowIso() });
    },
    async expireStalePending(olderThan) {
      let n = 0;
      for (const s of sends) {
        if (s.status === "pending" && s.updatedAt < olderThan) {
          Object.assign(s, { status: "failed", detail: "interrupted", attempts: MAX_SEND_ATTEMPTS, updatedAt: nowIso() });
          n++;
        }
      }
      return n;
    },
    async slackUser(id) {
      return slackUserCache.get(id) ?? null;
    },
    async saveSlackUser(id, slackUserId) {
      slackUserCache.set(id, { slackUserId, lookedUpAt: nowIso() });
    },
  };
  return store;
}
```

`src/lib/notify/context.ts`:
```ts
import type { ShapeFact } from "@/lib/explore/shape";
import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import { buildDigest, type Digest } from "./digest";
import { monthlyReadiness, sourceFreshness, type SourceFreshness, type SyncRunRow } from "./freshness";
import type { DigestPeriod } from "./schedule";
import type { NotifyStore } from "./store";
import { buildReportingTree, type ReportingTree } from "./tree";
import type { NotifyEmployee } from "./types";

export interface NotifyContext {
  now: Date;
  baseUrl: string;
  employees: NotifyEmployee[];
  employeesById: Map<string, NotifyEmployee>;
  tree: ReportingTree;
  facts: ShapeFact[];
  sourceHorizons: Record<string, string>;
  toolColors: Record<string, string>;
  freshness: SourceFreshness[];
  coverage: CoverageMonthRow[];
  syncRuns: SyncRunRow[];
}

/** 6-month monthly charts + the month before + projection history (trend lookback ≤ 4 complete months). */
export const HISTORY_MONTHS = 7;

export function factsWindow(now: Date, earliest?: string): { from: string; toExclusive: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - HISTORY_MONTHS, 1)).toISOString().slice(0, 10);
  const toExclusive = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  return { from: earliest && earliest < from ? earliest : from, toExclusive };
}

/** Yesterday 00:00 UTC — enough runs to know each source's latest outcome. */
export function syncRunsSince(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString();
}

/** Load everything a run (or a preview) needs ONCE: one fact read, split per recipient in memory. */
export async function loadNotifyContext(
  store: NotifyStore,
  now: Date,
  baseUrl: string,
  opts: { earliest?: string; coverage?: CoverageMonthRow[]; syncRuns?: SyncRunRow[] } = {},
): Promise<NotifyContext> {
  const w = factsWindow(now, opts.earliest);
  const [employees, facts, sourceHorizons, usageHorizons, toolColors, coverage, syncRuns] = await Promise.all([
    store.employees(),
    store.facts(w.from, w.toExclusive),
    store.sourceHorizons(),
    store.usageHorizons(),
    store.toolColors(),
    opts.coverage ?? store.importCoverage(now.toISOString().slice(0, 7)),
    opts.syncRuns ?? store.recentSyncRuns(syncRunsSince(now)),
  ]);
  return {
    now,
    baseUrl,
    employees,
    employeesById: new Map(employees.map((e) => [e.id, e])),
    tree: buildReportingTree(employees),
    facts,
    sourceHorizons,
    toolColors,
    freshness: sourceFreshness(syncRuns, usageHorizons),
    coverage,
    syncRuns,
  };
}

export function digestFor(ctx: NotifyContext, employeeId: string, period: DigestPeriod): Digest | null {
  const recipient = ctx.employeesById.get(employeeId);
  if (!recipient) return null;
  return buildDigest({
    recipient,
    reportIds: ctx.tree.reportsOf(employeeId),
    employeesById: ctx.employeesById,
    facts: ctx.facts,
    period,
    now: ctx.now,
    sourceHorizons: ctx.sourceHorizons,
    toolColors: ctx.toolColors,
    freshness: ctx.freshness,
    missingImports: period.cadence === "monthly" ? monthlyReadiness(ctx.coverage, period.key).missing : [],
    baseUrl: ctx.baseUrl,
  });
}
```

- [x] **Step 4: Run the tests and check they pass**

Run: `npx vitest run src/lib/notify/store.test.ts src/lib/notify/context.test.ts`
Expected: PASS

- [x] **Step 5: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
Expected: the build type-checks `store.ts` against the real Supabase client types. If `.match({... attempts: existing.attempts })` complains about the value type, cast `existing` once as `{ status: string; attempts: number }` at the read.
```bash
git add src/lib/notify/store.ts src/lib/notify/store.test.ts src/lib/notify/memory-store.ts src/lib/notify/context.ts src/lib/notify/context.test.ts
git commit -m "feat: NotifyStore (Supabase + in-memory) and one-read notify context

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Delivery and the orchestrator

**Files:**
- Create: `src/lib/notify/deliver.ts`
- Create: `src/lib/notify/run-notify.ts`
- Test: `src/lib/notify/run-notify.test.ts`

**Interfaces:**
- Consumes: Tasks 2–9.
- Produces:
  - `type RenderChart = (layout: ChartLayout) => Promise<Uint8Array<ArrayBuffer>>`
  - `chartLayoutsFor(d: Digest): { you: ChartLayout; reports?: ChartLayout }`
  - `SLACK_NOT_FOUND_TTL_MS`, `resolveSlackUser(store: Pick<NotifyStore, "slackUser" | "saveSlackUser">, slack: SlackClient, e: NotifyEmployee, now: Date): Promise<string | null>`
  - `deliverDigest(args: { slack: SlackClient; renderChart: RenderChart; slackUserId: string; digest: Digest; previewFor?: string; log?: (m: string) => void }): Promise<string>`
  - `interface RunNotifyDeps { store: NotifyStore; slack: SlackClient; renderChart: RenderChart; mode: SendMode; previewEmail: string | null; now: Date; baseUrl: string; budgetMs?: number; clock?: () => number; log?: (m: string) => void }`
  - `interface RunNotifyResult { due: string[]; sent: number; skipped: number; failed: number; alreadyHandled: number; notReached: number; expired: number; note?: string }`
  - `STALE_PENDING_MS`, `DEFAULT_BUDGET_MS`, `runNotify(deps): Promise<RunNotifyResult>`

- [x] **Step 1: Write the failing test.** `src/lib/notify/run-notify.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import { memoryStore, type MemorySeed } from "./memory-store";
import { runNotify, STALE_PENDING_MS, type RunNotifyDeps } from "./run-notify";
import { SlackApiError, type SlackClient } from "./slack-client";
import type { NotifyEmployee } from "./types";

const MONDAY = new Date("2026-09-28T07:00:00Z"); // daily 2026-09-27 + weekly 2026-W39 due
const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: `Person ${id}`, department: "Eng", oktaId: `00u${id}`, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
const fact = (day: string, usd: number, employeeId: string): ShapeFact => ({
  day, source: "cursor", costType: "overage", costUsd: usd, employeeId, department: "Eng", fullName: null, entityKey: employeeId, model: "",
});
const seed = (over: MemorySeed = {}): MemorySeed => ({
  employees: [emp("m"), emp("a", { managerRef: "00um" }), emp("gareth"), emp("gone", { leaveDate: "2026-09-01", employmentStatus: "deprovisioned" })],
  facts: [fact("2026-09-27", 12, "a"), fact("2026-09-22", 30, "m"), fact("2026-09-23", 50, "a")],
  subscriptions: [{ employeeId: "a", cadence: "daily" }, { employeeId: "m", cadence: "weekly" }, { employeeId: "gone", cadence: "weekly" }],
  syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-09-28T06:00:03Z" }],
  ...over,
});

function fakeSlack(over: Partial<SlackClient> = {}) {
  const posts: { channel: string; blocks: unknown[]; text: string }[] = [];
  const uploads: string[] = [];
  const client: SlackClient = {
    lookupUserByEmail: async (email) => (email.endsWith("@x.com") ? `U-${email.split("@")[0]}` : null),
    openDm: async (u) => `D-${u}`,
    uploadImage: async (_png, name) => {
      uploads.push(name);
      return `F${uploads.length}`;
    },
    postMessage: async (channel, blocks, text) => {
      posts.push({ channel, blocks, text });
      return `ts${posts.length}`;
    },
    ...over,
  };
  return { client, posts, uploads };
}
const png = async () => new Uint8Array([1]) as Uint8Array<ArrayBuffer>;
const deps = (store: ReturnType<typeof memoryStore>, slack: SlackClient, over: Partial<RunNotifyDeps> = {}): RunNotifyDeps => ({
  store, slack, renderChart: png, mode: "live", previewEmail: "gareth@x.com", now: MONDAY, baseUrl: "https://x.test",
  clock: () => MONDAY.getTime(), log: () => {}, ...over,
});
const hasImage = (blocks: unknown[]) => blocks.some((b) => (b as { type: string }).type === "image");

describe("runNotify", () => {
  it("sends each due digest once; a second run sends nothing", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    const slack = fakeSlack();
    const first = await runNotify(deps(store, slack.client));
    expect(first).toMatchObject({ due: ["daily:2026-09-27", "weekly:2026-W39"], sent: 2, failed: 0 });
    expect(slack.posts.map((p) => p.channel).sort()).toEqual(["D-U-a", "D-U-m"]);
    expect(store.sends.every((s) => s.status === "sent" && s.slackTs)).toBe(true);

    const second = await runNotify(deps(store, slack.client));
    expect(second).toMatchObject({ sent: 0, alreadyHandled: 2 });
    expect(slack.posts).toHaveLength(2);
  });

  it("never sends to leavers", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    await runNotify(deps(store, fakeSlack().client));
    expect(store.sends.some((s) => s.employeeId === "gone")).toBe(false);
  });

  it("preview mode redirects every DM to the preview address and logs mode=preview", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    const slack = fakeSlack();
    await runNotify(deps(store, slack.client, { mode: "preview" }));
    expect(slack.posts.every((p) => p.channel === "D-U-gareth")).toBe(true);
    expect(JSON.stringify(slack.posts[0].blocks[0])).toContain("would send to");
    expect(store.sends.every((s) => s.mode === "preview")).toBe(true);
    const live = await runNotify(deps(store, slack.client));
    expect(live.sent).toBe(2); // previews never count as live sends
  });

  it("refuses to run preview without a matching SLACK_PREVIEW_EMAIL", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    await expect(runNotify(deps(store, fakeSlack().client, { mode: "preview", previewEmail: "nobody@elsewhere.com" }))).rejects.toThrow(/SLACK_PREVIEW_EMAIL/);
  });

  it("isolates failures per recipient", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    let n = 0;
    const slack = fakeSlack({ postMessage: async () => { if (n++ === 0) throw new SlackApiError("chat.postMessage", "channel_not_found"); return "ts"; } });
    const r = await runNotify(deps(store, slack.client));
    expect(r).toMatchObject({ sent: 1, failed: 1 });
    expect(store.sends.find((s) => s.status === "failed")!.detail).toBe("channel_not_found");
  });

  it("retries a failed send while attempts remain, then stops", async () => {
    const base = { cadence: "daily" as const, periodKey: "2026-09-27", mode: "live" as const, slackTs: null, detail: "x", updatedAt: "2026-09-28T06:59:00Z", employeeId: "a" };
    const retry = memoryStore(seed({ sends: [{ ...base, status: "failed", attempts: 1 }] }), () => MONDAY.getTime());
    expect((await runNotify(deps(retry, fakeSlack().client))).sent).toBe(2);
    const spent = memoryStore(seed({ sends: [{ ...base, status: "failed", attempts: 3 }] }), () => MONDAY.getTime());
    expect(await runNotify(deps(spent, fakeSlack().client))).toMatchObject({ sent: 1, alreadyHandled: 1 });
  });

  it("expires stale pending rows as interrupted and never resends them", async () => {
    const stale = new Date(MONDAY.getTime() - STALE_PENDING_MS - 1000).toISOString();
    const store = memoryStore(
      seed({ sends: [{ employeeId: "a", cadence: "daily", periodKey: "2026-09-27", mode: "live", status: "pending", attempts: 1, slackTs: null, detail: null, updatedAt: stale }] }),
      () => MONDAY.getTime(),
    );
    const slack = fakeSlack();
    const r = await runNotify(deps(store, slack.client));
    expect(r).toMatchObject({ expired: 1, alreadyHandled: 1, sent: 1 });
    expect(store.sends.find((s) => s.employeeId === "a")).toMatchObject({ status: "failed", detail: "interrupted" });
    expect(slack.posts.map((p) => p.channel)).toEqual(["D-U-m"]);
  });

  it("does not resend when the DB write fails AFTER a successful post", async () => {
    const store = memoryStore(seed({ subscriptions: [{ employeeId: "a", cadence: "daily" }] }), () => MONDAY.getTime());
    store.failNextFinish = true;
    const slack = fakeSlack();
    const r = await runNotify(deps(store, slack.client));
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(store.sends[0].status).toBe("pending"); // left pending → expires as interrupted, never retried
    await runNotify(deps(store, slack.client));
    expect(slack.posts).toHaveLength(1);
  });

  it("stops claiming new recipients past the time budget", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    let t = MONDAY.getTime();
    const slack = fakeSlack({ postMessage: async () => { t += 300_000; return "ts"; } });
    const r = await runNotify(deps(store, slack.client, { clock: () => t, budgetMs: 240_000 }));
    expect(r).toMatchObject({ sent: 1, notReached: 1 });
  });

  it("sends text-only when chart rendering fails", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    const slack = fakeSlack();
    const r = await runNotify(deps(store, slack.client, { renderChart: async () => { throw new Error("satori"); } }));
    expect(r.sent).toBe(2);
    expect(slack.posts.some((p) => hasImage(p.blocks))).toBe(false);
  });

  it("resends without images when Slack rejects the image blocks", async () => {
    const store = memoryStore(seed({ subscriptions: [{ employeeId: "a", cadence: "daily" }] }), () => MONDAY.getTime());
    const posts: unknown[][] = [];
    const slack = fakeSlack({
      postMessage: async (_c, blocks) => {
        posts.push(blocks);
        if (hasImage(blocks)) throw new SlackApiError("chat.postMessage", "invalid_blocks");
        return "ts";
      },
    });
    expect((await runNotify(deps(store, slack.client))).sent).toBe(1);
    expect(posts.map(hasImage)).toEqual([true, false]);
  });

  it("skips daily/weekly entirely when no source synced today", async () => {
    const store = memoryStore(seed({ syncRuns: [] }), () => MONDAY.getTime());
    const slack = fakeSlack();
    const r = await runNotify(deps(store, slack.client));
    expect(r.due).toEqual([]);
    expect(r.note).toMatch(/no source synced/);
    expect(slack.posts).toHaveLength(0);
  });

  it("logs a daily with no usage as skipped and a missing Slack account as failed", async () => {
    const store = memoryStore(
      seed({ facts: [fact("2026-09-22", 30, "m")], employees: [emp("m"), emp("a", { managerRef: "00um", email: "a@elsewhere.com" }), emp("gareth")] }),
      () => MONDAY.getTime(),
    );
    const r = await runNotify(deps(store, fakeSlack().client));
    expect(store.sends.find((s) => s.employeeId === "a")).toMatchObject({ status: "skipped", detail: "no usage" });
    expect(r.skipped).toBe(1);

    const noSlack = memoryStore(seed({ employees: [emp("m", { email: "m@elsewhere.com" }), emp("a", { managerRef: "00um" }), emp("gareth")] }), () => MONDAY.getTime());
    await runNotify(deps(noSlack, fakeSlack().client));
    expect(noSlack.sends.find((s) => s.employeeId === "m")).toMatchObject({ status: "failed", detail: "no Slack account" });
    expect(noSlack.slackUserCache.get("m")).toMatchObject({ slackUserId: null });
  });
});
```

- [x] **Step 2: Run the test and check it fails**

Run: `npx vitest run src/lib/notify/run-notify.test.ts`
Expected: FAIL. Cannot find module `./run-notify`.

- [x] **Step 3: Implement**

`src/lib/notify/deliver.ts`:
```ts
import { chartLayout, type ChartLayout } from "./chart";
import type { Digest } from "./digest";
import { chartTitle, renderDigest, type ChartFileIds } from "./render";
import { SlackApiError, type SlackClient } from "./slack-client";
import type { NotifyStore } from "./store";
import type { NotifyEmployee } from "./types";

export type RenderChart = (layout: ChartLayout) => Promise<Uint8Array<ArrayBuffer>>;

/** One chart per section, each titled with whose numbers it shows. */
export function chartLayoutsFor(d: Digest): { you: ChartLayout; reports?: ChartLayout } {
  return {
    you: chartLayout(chartTitle("you", d), d.you.chart, d.you.chartTools, d.you.byTool),
    ...(d.reports ? { reports: chartLayout(chartTitle("reports", d), d.reports.chart, d.reports.chartTools, d.reports.byTool) } : {}),
  };
}

/** Best effort: a chart that fails to render or upload is simply left out. */
async function uploadCharts(slack: SlackClient, renderChart: RenderChart, d: Digest, log: (m: string) => void): Promise<ChartFileIds> {
  const files: ChartFileIds = {};
  for (const [section, layout] of Object.entries(chartLayoutsFor(d)) as ["you" | "reports", ChartLayout | undefined][]) {
    if (!layout) continue;
    try {
      files[section] = await slack.uploadImage(await renderChart(layout), `ai-spend-${section}.png`, layout.title);
    } catch (err) {
      log(`[notify] chart ${section} skipped: ${err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : String(err)}`);
    }
  }
  return files;
}

/** Trust a cached "not found" for a week before asking Slack again. */
export const SLACK_NOT_FOUND_TTL_MS = 7 * 86_400_000;

export async function resolveSlackUser(
  store: Pick<NotifyStore, "slackUser" | "saveSlackUser">,
  slack: SlackClient,
  e: NotifyEmployee,
  now: Date,
): Promise<string | null> {
  const cached = await store.slackUser(e.id);
  if (cached?.slackUserId) return cached.slackUserId;
  if (cached && now.getTime() - Date.parse(cached.lookedUpAt) < SLACK_NOT_FOUND_TTL_MS) return null;
  const id = await slack.lookupUserByEmail(e.email);
  await store.saveSlackUser(e.id, id);
  return id;
}

/** Upload charts, DM the digest; if Slack rejects the image blocks, resend as text only. Returns the message ts. */
export async function deliverDigest(args: {
  slack: SlackClient;
  renderChart: RenderChart;
  slackUserId: string;
  digest: Digest;
  previewFor?: string;
  log?: (m: string) => void;
}): Promise<string> {
  const { slack, digest, previewFor } = args;
  const log = args.log ?? console.log;
  const files = await uploadCharts(slack, args.renderChart, digest, log);
  const channel = await slack.openDm(args.slackUserId);
  const rendered = renderDigest(digest, files, { previewFor });
  try {
    return await slack.postMessage(channel, rendered.blocks, rendered.text);
  } catch (err) {
    const imageRejected = err instanceof SlackApiError && err.code.startsWith("invalid_blocks") && (files.you || files.reports);
    if (!imageRejected) throw err;
    log("[notify] image blocks rejected; resending without charts");
    const plain = renderDigest(digest, {}, { previewFor });
    return slack.postMessage(channel, plain.blocks, plain.text);
  }
}
```

`src/lib/notify/run-notify.ts`:
```ts
import { loadNotifyContext, digestFor, syncRunsSince } from "./context";
import { deliverDigest, resolveSlackUser, type RenderChart } from "./deliver";
import { anySyncSucceededToday, monthlyReadiness } from "./freshness";
import { dueDigests, latestCompleteKey, MONTHLY_WINDOW } from "./schedule";
import { SlackApiError, type SlackClient } from "./slack-client";
import type { NotifyStore, SendKey } from "./store";
import { isActiveEmployee, type SendMode } from "./types";

export interface RunNotifyDeps {
  store: NotifyStore;
  slack: SlackClient;
  renderChart: RenderChart;
  mode: SendMode;
  previewEmail: string | null;
  now: Date; // the morning being run (?date= replays in preview)
  baseUrl: string;
  budgetMs?: number;
  clock?: () => number; // real elapsed time (budget, stale cutoff)
  log?: (m: string) => void;
}

export interface RunNotifyResult {
  due: string[];
  sent: number;
  skipped: number;
  failed: number;
  alreadyHandled: number;
  notReached: number;
  expired: number;
  note?: string;
}

export const STALE_PENDING_MS = 10 * 60_000;
/** Stop claiming new recipients well inside the route's 300 s maxDuration. */
export const DEFAULT_BUDGET_MS = 240_000;

const errorDetail = (err: unknown) =>
  (err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * One cron run: expire interrupted claims, work out what's due, then per
 * (recipient, cadence) — isolated like runAllSyncs' sources — claim → build →
 * chart → DM → mark. A post that succeeded is NEVER followed by a retryable
 * state, even if the DB write after it fails.
 */
export async function runNotify(deps: RunNotifyDeps): Promise<RunNotifyResult> {
  const { store, slack, now } = deps;
  const clock = deps.clock ?? Date.now;
  const log = deps.log ?? console.log;
  const start = clock();
  const budget = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const result: RunNotifyResult = { due: [], sent: 0, skipped: 0, failed: 0, alreadyHandled: 0, notReached: 0, expired: 0 };

  result.expired = await store.expireStalePending(new Date(clock() - STALE_PENDING_MS).toISOString());

  const coverage = await store.importCoverage(now.toISOString().slice(0, 7));
  let due = dueDigests(now, monthlyReadiness(coverage, latestCompleteKey("monthly", now)).ready);
  const syncRuns = await store.recentSyncRuns(syncRunsSince(now));
  if (!anySyncSucceededToday(syncRuns, now)) {
    // No all-caveat messages. A monthly waits for tomorrow — except on the window's last day.
    const kept = due.filter((d) => d.period.cadence === "monthly" && now.getUTCDate() === MONTHLY_WINDOW.lastDay);
    if (kept.length < due.length) result.note = "no source synced successfully today — daily/weekly skipped";
    due = kept;
  }
  result.due = due.map((d) => `${d.period.cadence}:${d.period.key}`);
  if (!due.length) return result;

  const subs = await store.subscriptions(due.map((d) => d.period.cadence));
  if (!subs.length) return result;

  const ctx = await loadNotifyContext(store, now, deps.baseUrl, { coverage, syncRuns });
  const previewTarget =
    deps.mode === "preview" ? ctx.employees.find((e) => e.email === deps.previewEmail?.trim().toLowerCase()) : undefined;
  if (deps.mode === "preview" && !previewTarget) throw new Error("SLACK_PREVIEW_EMAIL does not match an employee");

  const periodByCadence = new Map(due.map((d) => [d.period.cadence, d.period]));
  for (const sub of subs) {
    const period = periodByCadence.get(sub.cadence);
    const recipient = ctx.employeesById.get(sub.employeeId);
    if (!period || !recipient || !isActiveEmployee(recipient)) continue;
    if (clock() - start > budget) {
      result.notReached++;
      continue;
    }
    const key: SendKey = { employeeId: recipient.id, cadence: sub.cadence, periodKey: period.key, mode: deps.mode };
    if (!(await store.claimSend(key))) {
      result.alreadyHandled++;
      continue;
    }

    let posted = false;
    try {
      const digest = digestFor(ctx, recipient.id, period);
      if (!digest) {
        await store.finishSend(key, { status: "skipped", detail: "no usage" });
        result.skipped++;
        continue;
      }
      const slackUserId = await resolveSlackUser(store, slack, previewTarget ?? recipient, new Date(clock()));
      if (!slackUserId) {
        await store.finishSend(key, { status: "failed", detail: "no Slack account" });
        result.failed++;
        continue;
      }
      const ts = await deliverDigest({
        slack,
        renderChart: deps.renderChart,
        slackUserId,
        digest,
        previewFor: previewTarget ? `${recipient.fullName} (${sub.cadence})` : undefined,
        log,
      });
      posted = true;
      await store.finishSend(key, { status: "sent", slackTs: ts });
      result.sent++;
    } catch (err) {
      if (posted) {
        // The DM went out; leave the row pending → it expires as "interrupted" and is never retried.
        result.sent++;
        log(`[notify] sent but not recorded employee=${recipient.id} cadence=${sub.cadence}: ${errorDetail(err)}`);
      } else {
        result.failed++;
        log(`[notify] send failed employee=${recipient.id} cadence=${sub.cadence}: ${errorDetail(err)}`);
        await store.finishSend(key, { status: "failed", detail: errorDetail(err) }).catch(() => undefined);
      }
    }
  }

  log(`[notify] mode=${deps.mode} due=${result.due.join(",")} sent=${result.sent} skipped=${result.skipped} failed=${result.failed} notReached=${result.notReached} expired=${result.expired}`);
  return result;
}
```

- [x] **Step 4: Run the test and check it passes**

Run: `npx vitest run src/lib/notify/run-notify.test.ts`
Expected: PASS. If "retries a failed send" shows `sent: 1`, check that `memoryStore.claimSend` retakes the seeded failed row (attempts 1 → 2) and that `a`'s daily digest isn't null (the fact on 2026-09-27 gives it usage).

- [x] **Step 5: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
```bash
git add src/lib/notify/deliver.ts src/lib/notify/run-notify.ts src/lib/notify/run-notify.test.ts
git commit -m "feat: notify orchestrator — claim-before-send, preview redirect, isolated sends

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Cron route and wiring

**Files:**
- Create: `src/lib/notify/wiring.ts`
- Create: `src/app/api/cron/notify/route.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `runNotify` (Task 10), `supabaseNotifyStore` (Task 9), `createSlackClient` (Task 8), `renderChartPng` (Task 6), `resolveRunDate` (Task 3), `notifyMode` (Task 2), `isCronAuthorized`, `getSupabaseAdminClient`.
- Produces: `slackClientFromEnv(): SlackClient`, `appBaseUrl(): string`; `GET /api/cron/notify` (optional `?date=YYYY-MM-DD`, preview only).

- [x] **Step 1: Implement the wiring.** `src/lib/notify/wiring.ts`:
```ts
import "server-only";
import { createSlackClient, type SlackClient } from "./slack-client";

/** The ONLY reader of SLACK_BOT_TOKEN (server-only keeps it out of any client bundle). */
export function slackClientFromEnv(): SlackClient {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  return createSlackClient(token);
}

/** Base for dashboard links in DMs. */
export function appBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? `https://${prod}` : "http://localhost:3000";
}
```

- [x] **Step 2: Implement the route.** `src/app/api/cron/notify/route.ts`:
```ts
import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { renderChartPng } from "@/lib/notify/chart-image";
import { runNotify } from "@/lib/notify/run-notify";
import { resolveRunDate } from "@/lib/notify/schedule";
import { supabaseNotifyStore } from "@/lib/notify/store";
import { notifyMode } from "@/lib/notify/types";
import { appBaseUrl, slackClientFromEnv } from "@/lib/notify/wiring";

export const dynamic = "force-dynamic";
// Each DM is ~4 Slack calls; runNotify stops claiming at 240 s inside this.
export const maxDuration = 300;

/**
 * Daily Slack spend digests (Vercel Cron 07:00 UTC, an hour after the sync).
 * CRON_SECRET-gated (fails closed). SLACK_NOTIFY_MODE off|preview|live — off
 * (the default) returns without touching anything. ?date=YYYY-MM-DD replays
 * that morning, preview mode only.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const mode = notifyMode();
  if (mode === "off") return NextResponse.json({ mode, skipped: "SLACK_NOTIFY_MODE is off" });

  const runDate = resolveRunDate(new URL(req.url).searchParams.get("date"), mode, new Date());
  if ("error" in runDate) return NextResponse.json({ error: runDate.error }, { status: 400 });

  try {
    const result = await runNotify({
      store: supabaseNotifyStore(getSupabaseAdminClient()),
      slack: slackClientFromEnv(),
      renderChart: renderChartPng,
      mode,
      previewEmail: process.env.SLACK_PREVIEW_EMAIL ?? null,
      now: runDate.now,
      baseUrl: appBaseUrl(),
    });
    return NextResponse.json({ ranAt: new Date().toISOString(), mode, ...result });
  } catch (err) {
    return NextResponse.json({ mode, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
```

- [x] **Step 3: Register the cron.** Replace the `crons` array in `vercel.json`:
```json
  "crons": [
    {
      "path": "/api/cron/sync",
      "schedule": "0 6 * * *"
    },
    {
      "path": "/api/cron/notify",
      "schedule": "0 7 * * *"
    }
  ]
```

- [x] **Step 4: Check the build and the auth gate**

Run: `npm run test && npm run lint && CI=true npm run build`
Expected: PASS. Then, with `npm run dev` running and **`SLACK_NOTIFY_MODE` unset**:
```bash
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/cron/notify
curl -s -H "Authorization: Bearer $(grep ^CRON_SECRET .env.local | cut -d= -f2-)" localhost:3000/api/cron/notify
```
Expected: `401`, then `{"mode":"off","skipped":"SLACK_NOTIFY_MODE is off"}`.

- [x] **Step 5: Commit**
```bash
git add src/lib/notify/wiring.ts src/app/api/cron/notify/route.ts vercel.json
git commit -m "feat: /api/cron/notify at 07:00 UTC (off by default, preview-only replays)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Admin Notifications tab

**Files:**
- Create: `src/lib/notify/admin-store.ts`
- Create: `src/app/(dashboard)/data/notifications-actions.ts`
- Create: `src/app/(dashboard)/data/notifications-tab.tsx`
- Create: `src/components/notifications/recipients-table.tsx`
- Create: `src/components/notifications/block-kit-preview.tsx`
- Create: `src/components/notifications/send-preview-button.tsx`
- Modify: `src/app/(dashboard)/data/page.tsx`

**Interfaces:**
- Consumes: everything above; `Panel` (`src/components/ui.tsx`); `requireAdmin`; `auth` (`src/auth.ts`).
- Produces:
  - `interface RecipientRow { employeeId: string; name: string; team: string | null; cadences: Cadence[]; reports: number; slack: "found" | "not_found" | "unknown"; lastSent: string | null; left: boolean }`
  - `interface SendLogRow { at: string; name: string; cadence: string; periodKey: string; mode: string; status: string; detail: string | null }`
  - `interface NotificationsAdminData { recipients: RecipientRow[]; sends: SendLogRow[]; lastRun: { day: string; sent: number; skipped: number; failed: number } | null; tree: { active: number; resolved: number; unresolved: string[] }; people: { id: string; label: string }[]; departments: string[] }`
  - `loadNotificationsAdmin(supabase)`, `addSubscriptions(supabase, ids, cadences, createdBy): Promise<number>`, `setSubscription(supabase, id, cadence, enabled, createdBy)`, `removeSubscriptions(supabase, id)`
  - Server actions `addRecipients`, `addTeamRecipients`, `setRecipientCadence`, `removeRecipient`, `sendPreviewToMe`
  - `<NotificationsTab params={{ preview?, cadence?, at? }} />`

This task is UI and integration code. The logic underneath is already covered by Tasks 2–10, so it's verified by build, lint and Local QA (Task 13) rather than new unit tests.

- [x] **Step 1: The admin store.** `src/lib/notify/admin-store.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { pageAll } from "./store";
import { buildReportingTree } from "./tree";
import { isActiveEmployee, NOTIFY_EMPLOYEE_COLUMNS, toNotifyEmployee, type Cadence } from "./types";

export interface RecipientRow {
  employeeId: string;
  name: string;
  team: string | null;
  cadences: Cadence[];
  reports: number; // active descendants
  slack: "found" | "not_found" | "unknown";
  lastSent: string | null; // "weekly · 2026-09-28"
  left: boolean;
}
export interface SendLogRow { at: string; name: string; cadence: string; periodKey: string; mode: string; status: string; detail: string | null }
export interface NotificationsAdminData {
  recipients: RecipientRow[];
  sends: SendLogRow[]; // newest first, ≤ 50
  lastRun: { day: string; sent: number; skipped: number; failed: number } | null;
  tree: { active: number; resolved: number; unresolved: string[] };
  people: { id: string; label: string }[]; // active, not yet enrolled — "Name — Team"
  departments: string[];
}

export async function loadNotificationsAdmin(supabase: SupabaseClient): Promise<NotificationsAdminData> {
  const [subs, empRows, slackRows, sendRes] = await Promise.all([
    pageAll<{ employee_id: string; cadence: Cadence }>(
      (a, b) => supabase.from("notification_subscriptions").select("employee_id, cadence").order("employee_id").order("cadence").range(a, b),
      "notification_subscriptions",
    ),
    fetchEmployeesAll(supabase, NOTIFY_EMPLOYEE_COLUMNS),
    pageAll<{ employee_id: string; slack_user_id: string | null }>(
      (a, b) => supabase.from("slack_users").select("employee_id, slack_user_id").order("employee_id").range(a, b),
      "slack_users",
    ),
    // Bounded newest-first read of a growing log — never a full scan.
    supabase.from("notification_sends").select("employee_id, cadence, period_key, mode, status, detail, updated_at").order("updated_at", { ascending: false }).order("id").limit(200),
  ]);
  if (sendRes.error) throw new Error(`notification_sends: ${sendRes.error.message}`);

  const employees = empRows.map(toNotifyEmployee);
  const byId = new Map(employees.map((e) => [e.id, e]));
  const tree = buildReportingTree(employees);
  const slack = new Map(slackRows.map((r) => [r.employee_id, r.slack_user_id]));
  const sends = (sendRes.data ?? []) as { employee_id: string; cadence: string; period_key: string; mode: string; status: string; detail: string | null; updated_at: string }[];

  const cadencesBy = new Map<string, Cadence[]>();
  for (const s of subs) cadencesBy.set(s.employee_id, [...(cadencesBy.get(s.employee_id) ?? []), s.cadence]);

  const recipients: RecipientRow[] = [...cadencesBy].map(([id, cadences]) => {
    const e = byId.get(id);
    const last = sends.find((s) => s.employee_id === id && s.status === "sent");
    return {
      employeeId: id,
      name: e?.fullName ?? "Unknown",
      team: e?.department ?? null,
      cadences,
      reports: tree.reportsOf(id).filter((r) => { const x = byId.get(r); return x ? isActiveEmployee(x) : false; }).length,
      slack: !slack.has(id) ? "unknown" : slack.get(id) ? "found" : "not_found",
      lastSent: last ? `${last.cadence} · ${last.updated_at.slice(0, 10)}` : null,
      left: e ? !isActiveEmployee(e) : true,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const lastDay = sends[0]?.updated_at.slice(0, 10) ?? null;
  const ofLastDay = lastDay ? sends.filter((s) => s.updated_at.startsWith(lastDay)) : [];
  const active = employees.filter(isActiveEmployee);
  const unresolved = new Set(tree.unresolved);

  return {
    recipients,
    sends: sends.slice(0, 50).map((s) => ({
      at: s.updated_at, name: byId.get(s.employee_id)?.fullName ?? "Unknown", cadence: s.cadence,
      periodKey: s.period_key, mode: s.mode, status: s.status, detail: s.detail,
    })),
    lastRun: lastDay
      ? { day: lastDay, sent: ofLastDay.filter((s) => s.status === "sent").length, skipped: ofLastDay.filter((s) => s.status === "skipped").length, failed: ofLastDay.filter((s) => s.status === "failed").length }
      : null,
    tree: { active: active.length, resolved: active.filter((e) => !unresolved.has(e.id)).length, unresolved: active.filter((e) => unresolved.has(e.id)).map((e) => e.fullName).sort() },
    people: active.filter((e) => !cadencesBy.has(e.id)).map((e) => ({ id: e.id, label: `${e.fullName} — ${e.department ?? "No team"}` })).sort((a, b) => a.label.localeCompare(b.label)),
    departments: [...new Set(active.map((e) => e.department).filter((d): d is string => !!d))].sort(),
  };
}

export async function addSubscriptions(supabase: SupabaseClient, employeeIds: string[], cadences: Cadence[], createdBy: string): Promise<number> {
  const rows = employeeIds.flatMap((employee_id) => cadences.map((cadence) => ({ employee_id, cadence, created_by: createdBy })));
  const { data, error } = await supabase
    .from("notification_subscriptions")
    .upsert(rows, { onConflict: "employee_id,cadence", ignoreDuplicates: true })
    .select("employee_id");
  if (error) throw new Error(`addSubscriptions: ${error.message}`);
  return data?.length ?? 0;
}

export async function setSubscription(supabase: SupabaseClient, employeeId: string, cadence: Cadence, enabled: boolean, createdBy: string): Promise<void> {
  if (enabled) {
    await addSubscriptions(supabase, [employeeId], [cadence], createdBy);
    return;
  }
  const { error } = await supabase.from("notification_subscriptions").delete().eq("employee_id", employeeId).eq("cadence", cadence);
  if (error) throw new Error(`setSubscription: ${error.message}`);
}

export async function removeSubscriptions(supabase: SupabaseClient, employeeId: string): Promise<void> {
  const { error } = await supabase.from("notification_subscriptions").delete().eq("employee_id", employeeId);
  if (error) throw new Error(`removeSubscriptions: ${error.message}`);
}
```

- [x] **Step 2: Server actions.** `src/app/(dashboard)/data/notifications-actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { addSubscriptions, removeSubscriptions, setSubscription } from "@/lib/notify/admin-store";
import { renderChartPng } from "@/lib/notify/chart-image";
import { digestFor, loadNotifyContext } from "@/lib/notify/context";
import { deliverDigest, resolveSlackUser } from "@/lib/notify/deliver";
import { periodFor } from "@/lib/notify/schedule";
import { supabaseNotifyStore } from "@/lib/notify/store";
import { isActiveEmployee, isCadence, isUuid, NOTIFY_EMPLOYEE_COLUMNS, toNotifyEmployee, type Cadence } from "@/lib/notify/types";
import { appBaseUrl, slackClientFromEnv } from "@/lib/notify/wiring";

const MAX_BATCH = 500;

function cadencesOrThrow(input: unknown): Cadence[] {
  if (!Array.isArray(input) || input.length === 0 || !input.every(isCadence)) throw new Error("Pick at least one valid cadence");
  return [...new Set(input)];
}

/** The signed-in admin's email (dev bypass has no session: fall back to SLACK_PREVIEW_EMAIL in development only). */
async function actorEmail(): Promise<string> {
  const session = await auth().catch(() => null);
  const email = session?.user?.email?.toLowerCase();
  if (email) return email;
  if (process.env.NODE_ENV === "development" && process.env.SLACK_PREVIEW_EMAIL) return process.env.SLACK_PREVIEW_EMAIL.toLowerCase();
  throw new Error("No signed-in email");
}

export async function addRecipients(employeeIds: string[], cadences: string[]): Promise<{ added: number }> {
  await requireAdmin();
  if (!Array.isArray(employeeIds) || !employeeIds.length || employeeIds.length > MAX_BATCH || !employeeIds.every(isUuid)) {
    throw new Error("Invalid people selection");
  }
  const added = await addSubscriptions(getSupabaseAdminClient(), employeeIds, cadencesOrThrow(cadences), await actorEmail());
  revalidatePath("/data");
  return { added };
}

/** Enrols a team's CURRENT active members once; later joiners are not auto-enrolled. */
export async function addTeamRecipients(department: string, cadences: string[]): Promise<{ added: number }> {
  await requireAdmin();
  if (typeof department !== "string" || !department.trim()) throw new Error("Pick a team");
  const supabase = getSupabaseAdminClient();
  const members = (await fetchEmployeesAll(supabase, NOTIFY_EMPLOYEE_COLUMNS, { department })).map(toNotifyEmployee).filter(isActiveEmployee);
  if (!members.length) throw new Error(`No active people in ${department}`);
  if (members.length > MAX_BATCH) throw new Error("Team too large to add at once");
  const added = await addSubscriptions(supabase, members.map((m) => m.id), cadencesOrThrow(cadences), await actorEmail());
  revalidatePath("/data");
  return { added };
}

export async function setRecipientCadence(employeeId: string, cadence: string, enabled: boolean): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId) || !isCadence(cadence) || typeof enabled !== "boolean") throw new Error("Invalid input");
  await setSubscription(getSupabaseAdminClient(), employeeId, cadence, enabled, await actorEmail());
  revalidatePath("/data");
}

export async function removeRecipient(employeeId: string): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId)) throw new Error("Invalid input");
  await removeSubscriptions(getSupabaseAdminClient(), employeeId);
  revalidatePath("/data");
}

/** DMs the previewed digest to the SIGNED-IN admin only. Never logged as a send, never sent to the recipient. */
export async function sendPreviewToMe(employeeId: string, cadence: string, periodKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireAdmin();
  if (!isUuid(employeeId) || !isCadence(cadence) || typeof periodKey !== "string") return { ok: false, error: "Invalid input" };
  try {
    const now = new Date();
    const period = periodFor(cadence, periodKey, now);
    const store = supabaseNotifyStore(getSupabaseAdminClient());
    const ctx = await loadNotifyContext(store, now, appBaseUrl(), { earliest: period.buckets[0].from });
    const digest = digestFor(ctx, employeeId, period);
    if (!digest) return { ok: false, error: "Nothing to send for that period (no usage)" };
    const email = await actorEmail();
    const me = ctx.employees.find((e) => e.email === email);
    if (!me) return { ok: false, error: "Your email isn't in the employee list" };
    const slack = slackClientFromEnv();
    const slackUserId = await resolveSlackUser(store, slack, me, now);
    if (!slackUserId) return { ok: false, error: "No Slack account found for your email" };
    await deliverDigest({ slack, renderChart: renderChartPng, slackUserId, digest, previewFor: `${digest.recipient.name} (${cadence})` });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [x] **Step 3: Components**

`src/components/notifications/block-kit-preview.tsx`:
```tsx
import { parseMrkdwn } from "@/lib/notify/mrkdwn";
import type { SlackBlock } from "@/lib/notify/render";

function Mrk({ text }: { text: string }) {
  return (
    <>
      {parseMrkdwn(text).map((n, i) =>
        n.t === "br" ? <br key={i} /> :
        n.t === "bold" ? <strong key={i} className="font-extrabold">{n.v}</strong> :
        n.t === "link" ? <a key={i} href={n.href} className="text-[#1264a3]">{n.v}</a> :
        <span key={i}>{n.v}</span>,
      )}
    </>
  );
}

function Block({ block, images }: { block: SlackBlock; images: Record<string, string> }) {
  switch (block.type) {
    case "header":
      return <p className="mb-2 text-[15px] font-black">{(block.text as { text: string }).text}</p>;
    case "section":
      return <p className="mt-2"><Mrk text={(block.text as { text: string }).text} /></p>;
    case "image": {
      const src = images[(block.slack_file as { id: string }).id];
      // eslint-disable-next-line @next/next/no-img-element -- data-URL preview of the exact PNG the DM carries
      return src ? <img src={src} alt={block.alt_text as string} className="my-1.5 w-full rounded border border-[#e8e8e8]" /> : null;
    }
    case "context":
      return (
        <div className="mt-1 text-[11.5px] text-[#616061]">
          {(block.elements as { text: string }[]).map((e, i) => <p key={i}><Mrk text={e.text} /></p>)}
        </div>
      );
    case "divider":
      return <hr className="my-3 border-[#e8e8e8]" />;
    case "actions":
      return (
        <div className="mt-3 flex gap-2">
          {(block.elements as { text: { text: string }; url: string }[]).map((e, i) => (
            <a key={i} href={e.url} className="rounded border border-[#bbbabb] px-3 py-0.5 text-[12px] font-bold">{e.text.text}</a>
          ))}
        </div>
      );
    default:
      return null;
  }
}

/** Renders the SAME Block Kit renderDigest sends; chart file ids map to data-URL PNGs. */
export function BlockKitPreview({ blocks, images }: { blocks: SlackBlock[]; images: Record<string, string> }) {
  return (
    <div className="rounded-md bg-white p-4 text-[13px] leading-relaxed text-[#1d1c1d]">
      {blocks.map((b, i) => <Block key={i} block={b} images={images} />)}
    </div>
  );
}
```

`src/components/notifications/send-preview-button.tsx`:
```tsx
"use client";

import { useState, useTransition } from "react";
import { sendPreviewToMe } from "@/app/(dashboard)/data/notifications-actions";

export function SendPreviewButton({ employeeId, cadence, periodKey }: { employeeId: string; cadence: string; periodKey: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="mt-3 flex items-center gap-3">
      <button
        onClick={() => start(async () => {
          setMsg(null);
          const r = await sendPreviewToMe(employeeId, cadence, periodKey);
          setMsg(r.ok ? "Sent to you in Slack." : `Failed: ${r.error}`);
        })}
        disabled={pending}
        className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-xs text-accent disabled:opacity-40"
      >
        {pending ? "Sending…" : "Send this to me in Slack"}
      </button>
      <span className="text-xs text-muted">{msg ?? "Doesn't count as a send and never goes to the recipient"}</span>
    </div>
  );
}
```

`src/components/notifications/recipients-table.tsx`:
```tsx
"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { addRecipients, addTeamRecipients, removeRecipient, setRecipientCadence } from "@/app/(dashboard)/data/notifications-actions";
import type { RecipientRow } from "@/lib/notify/admin-store";
import { CADENCES, type Cadence } from "@/lib/notify/types";

const LABEL: Record<Cadence, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
const SLACK: Record<RecipientRow["slack"], { text: string; cls: string }> = {
  found: { text: "✓", cls: "text-emerald-400" },
  not_found: { text: "✗ not found", cls: "text-pink-400" },
  unknown: { text: "not looked up", cls: "text-muted" },
};

export function RecipientsTable({ rows, people, departments, previewing }: {
  rows: RecipientRow[];
  people: { id: string; label: string }[];
  departments: string[];
  previewing: string | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const [team, setTeam] = useState("");
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
        <datalist id="notify-people">{people.map((p) => <option key={p.id} value={p.label} />)}</datalist>
        <input
          list="notify-people" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Add a person…"
          className="w-56 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
        />
        <button
          disabled={pending || !idByLabel.has(person)}
          onClick={() => run(async () => { await addRecipients([idByLabel.get(person)!], defaults); setPerson(""); })}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40"
        >Add</button>
        <select value={team} onChange={(e) => setTeam(e.target.value)} className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground">
          <option value="">Add a team…</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button
          disabled={pending || !team}
          onClick={() => run(async () => { await addTeamRecipients(team, defaults); setTeam(""); })}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40"
        >Add team</button>
        <span className="ml-2 text-muted">New people get:</span>
        {CADENCES.map((c) => (
          <label key={c} className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={defaults.includes(c)} onChange={(e) => setDefaults((d) => (e.target.checked ? [...d, c] : d.filter((x) => x !== c)))} />
            {LABEL[c]}
          </label>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody is enrolled yet. Only people listed here get anything.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Person</th>
                {CADENCES.map((c) => <th key={c} className="px-2 py-2 text-center font-medium">{LABEL[c]}</th>)}
                <th className="px-3 py-2 font-medium">Reports</th>
                <th className="px-3 py-2 font-medium">Slack</th>
                <th className="px-3 py-2 font-medium">Last sent</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId} className={`border-b border-border/60 last:border-0 ${previewing === r.employeeId ? "bg-accent/5" : ""}`}>
                  <td className="px-3 py-2">
                    <span className="font-medium">{r.name}</span>
                    {r.left && <span className="ml-2 rounded bg-pink-500/15 px-1.5 text-[10px] text-pink-300">left</span>}
                    <div className="text-xs text-muted">{r.team ?? "No team"}</div>
                  </td>
                  {CADENCES.map((c) => (
                    <td key={c} className="px-2 py-2 text-center">
                      <input
                        type="checkbox" disabled={pending} checked={r.cadences.includes(c)}
                        onChange={(e) => run(() => setRecipientCadence(r.employeeId, c, e.target.checked))}
                        aria-label={`${LABEL[c]} for ${r.name}`}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2">{r.reports || "—"}</td>
                  <td className={`px-3 py-2 text-xs ${SLACK[r.slack].cls}`}>{SLACK[r.slack].text}</td>
                  <td className="px-3 py-2 text-xs text-muted">{r.lastSent ?? "never"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-xs">
                    <Link href={`/data?tab=notifications&preview=${r.employeeId}&cadence=${r.cadences[0] ?? "weekly"}`} className="mr-3 text-accent">Preview</Link>
                    <button disabled={pending} onClick={() => run(() => removeRecipient(r.employeeId))} className="text-muted hover:text-pink-300">Remove</button>
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

- [x] **Step 4: The tab.** `src/app/(dashboard)/data/notifications-tab.tsx`:
```tsx
import Link from "next/link";
import { Panel } from "@/components/ui";
import { BlockKitPreview } from "@/components/notifications/block-kit-preview";
import { RecipientsTable } from "@/components/notifications/recipients-table";
import { SendPreviewButton } from "@/components/notifications/send-preview-button";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadNotificationsAdmin } from "@/lib/notify/admin-store";
import { renderChartPng } from "@/lib/notify/chart-image";
import { digestFor, loadNotifyContext } from "@/lib/notify/context";
import { chartLayoutsFor } from "@/lib/notify/deliver";
import { renderDigest, type ChartFileIds, type SlackBlock } from "@/lib/notify/render";
import { latestCompleteKey, periodFor, stepKey } from "@/lib/notify/schedule";
import { supabaseNotifyStore } from "@/lib/notify/store";
import { CADENCES, isCadence, isUuid, notifyMode, type Cadence } from "@/lib/notify/types";
import { appBaseUrl } from "@/lib/notify/wiring";

export interface NotificationsParams { preview?: string; cadence?: string; at?: string }

interface PreviewState {
  employeeId: string;
  name: string;
  cadence: Cadence;
  key: string;
  label: string;
  prevKey: string | null;
  nextKey: string | null;
  blocks: SlackBlock[] | null; // null = nothing to send (daily with no usage)
  images: Record<string, string>;
}

async function loadPreview(p: NotificationsParams): Promise<PreviewState | null> {
  if (!isUuid(p.preview)) return null;
  const cadence: Cadence = isCadence(p.cadence) ? p.cadence : "weekly";
  const now = new Date();
  let key = p.at ?? latestCompleteKey(cadence, now);
  let period;
  try {
    period = periodFor(cadence, key, now);
  } catch {
    key = latestCompleteKey(cadence, now);
    period = periodFor(cadence, key, now);
  }
  const ctx = await loadNotifyContext(supabaseNotifyStore(getSupabaseAdminClient()), now, appBaseUrl(), { earliest: period.buckets[0].from });
  const digest = digestFor(ctx, p.preview, period);
  const base = {
    employeeId: p.preview, name: ctx.employeesById.get(p.preview)?.fullName ?? "Unknown", cadence, key, label: period.label,
    prevKey: stepKey(cadence, key, -1, now), nextKey: stepKey(cadence, key, 1, now),
  };
  if (!digest) return { ...base, blocks: null, images: {} };
  const images: Record<string, string> = {};
  const files: ChartFileIds = {};
  for (const [section, layout] of Object.entries(chartLayoutsFor(digest)) as ["you" | "reports", Parameters<typeof renderChartPng>[0] | undefined][]) {
    if (!layout) continue;
    const id = `preview-${section}`;
    images[id] = `data:image/png;base64,${Buffer.from(await renderChartPng(layout)).toString("base64")}`;
    files[section] = id;
  }
  return { ...base, blocks: renderDigest(digest, files).blocks, images };
}

const href = (p: { employeeId: string; cadence: string; key?: string | null }) =>
  `/data?tab=notifications&preview=${p.employeeId}&cadence=${p.cadence}${p.key ? `&at=${p.key}` : ""}`;

export async function NotificationsTab({ params }: { params: NotificationsParams }) {
  const [data, preview] = await Promise.all([loadNotificationsAdmin(getSupabaseAdminClient()), loadPreview(params)]);
  const mode = notifyMode();

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Panel>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">Mode</p>
          <p className="my-1 text-sm font-semibold">{mode.toUpperCase()}</p>
          <p className="text-xs text-muted">
            {mode === "off" && "Nothing is sent. "}
            {mode === "preview" && `Every DM goes to ${process.env.SLACK_PREVIEW_EMAIL ?? "(SLACK_PREVIEW_EMAIL unset)"}, not the recipient. `}
            {mode === "live" && "DMs go to the recipients below. "}
            Change <code>SLACK_NOTIFY_MODE</code> in Vercel.
          </p>
        </Panel>
        <Panel>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">Last run</p>
          {data.lastRun ? (
            <>
              <p className="my-1 text-sm font-semibold">{data.lastRun.day}</p>
              <p className="text-xs text-muted">{data.lastRun.sent} sent · {data.lastRun.skipped} skipped · {data.lastRun.failed} failed</p>
            </>
          ) : <p className="my-1 text-sm text-muted">No sends yet</p>}
        </Panel>
        <Panel>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">Manager chain (Okta)</p>
          <p className="my-1 text-sm font-semibold">{data.tree.resolved} / {data.tree.active} resolved</p>
          {data.tree.unresolved.length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">{data.tree.unresolved.length} active people have no resolvable manager</summary>
              <p className="mt-1">They still get their own digest but don&apos;t roll up to anyone: {data.tree.unresolved.join(", ")}</p>
            </details>
          )}
        </Panel>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Panel>
          <h2 className="mb-1 text-sm font-medium">Pilot recipients · {data.recipients.length}</h2>
          <p className="mb-4 text-xs text-muted">Only people listed here get anything. Checkboxes save as you click. Reports come from the Okta manager chain.</p>
          <RecipientsTable rows={data.recipients} people={data.people} departments={data.departments} previewing={preview?.employeeId ?? null} />
        </Panel>

        <Panel>
          {!preview ? (
            <p className="text-sm text-muted">Click Preview on a recipient to see exactly what they&apos;d get.</p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">Preview · {preview.name}</h2>
                <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
                  {CADENCES.map((c) => (
                    <Link key={c} href={href({ employeeId: preview.employeeId, cadence: c })}
                      className={`rounded px-2.5 py-1 ${c === preview.cadence ? "bg-accent/20 text-accent" : "text-muted"}`}>{c}</Link>
                  ))}
                </div>
              </div>
              <p className="mb-3 text-xs text-muted">
                {preview.prevKey ? <Link href={href({ ...preview, key: preview.prevKey })} className="text-accent">◀</Link> : "◀"}
                <span className="mx-2 text-foreground">{preview.label}</span>
                {preview.nextKey ? <Link href={href({ ...preview, key: preview.nextKey })} className="text-accent">▶</Link> : "▶"}
                <span className="ml-2">Built from live data, exactly as the cron would send it.</span>
              </p>
              {preview.blocks ? (
                <>
                  <BlockKitPreview blocks={preview.blocks} images={preview.images} />
                  <SendPreviewButton employeeId={preview.employeeId} cadence={preview.cadence} periodKey={preview.key} />
                </>
              ) : <p className="text-sm text-muted">Nothing to send for this period: no usage by them or their reports.</p>}
            </>
          )}
        </Panel>
      </div>

      <Panel>
        <h2 className="mb-1 text-sm font-medium">Recent sends</h2>
        <p className="mb-4 text-xs text-muted">Last 50 log entries. Failed sends retry on the next run while the period is still due (up to 3 attempts).</p>
        {data.sends.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  {["When", "Person", "Cadence", "Period", "Mode", "Status", "Detail"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.sends.map((s, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2 text-xs text-muted">{s.at.slice(0, 16).replace("T", " ")}</td>
                    <td className="px-3 py-2">{s.name}</td>
                    <td className="px-3 py-2">{s.cadence}</td>
                    <td className="px-3 py-2 text-xs">{s.periodKey}</td>
                    <td className="px-3 py-2 text-xs">{s.mode}</td>
                    <td className={`px-3 py-2 text-xs ${s.status === "failed" ? "text-pink-300" : s.status === "sent" ? "text-emerald-400" : "text-muted"}`}>{s.status}</td>
                    <td className="px-3 py-2 text-xs text-muted">{s.detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
```

- [x] **Step 5: Register the tab.** In `src/app/(dashboard)/data/page.tsx`:

Add the import:
```tsx
import { NotificationsTab } from "./notifications-tab";
```
Add to `TABS` (after `sync`):
```tsx
  { key: "notifications", label: "Notifications", admin: true, subtitle: "Slack spend digests: pilot recipients, cadences, previews and the send log." },
```
Change the page signature and the search-params read:
```tsx
export default async function DataPage({ searchParams }: { searchParams: Promise<{ tab?: string; preview?: string; cadence?: string; at?: string }> }) {
  const isAdmin = (await getRole()) === "admin";
  const sp = await searchParams;
  const requested = sp.tab as TabKey | undefined;
```
Add the render line after the `sync` one:
```tsx
      {active.key === "notifications" && <NotificationsTab params={{ preview: sp.preview, cadence: sp.cadence, at: sp.at }} />}
```

- [x] **Step 6: Verify**

Run: `npm run test && npm run lint && CI=true npm run build`
Expected: PASS. Then `npm run dev`, sign in as an admin (or `AUTH_DISABLED=true` locally), open `/data?tab=notifications`. Expected: three status cards, an empty recipients table, and "Click Preview…". A non-admin must not see the tab (the TABS `admin: true` filter).

- [x] **Step 7: Commit**
```bash
git add src/lib/notify/admin-store.ts "src/app/(dashboard)/data/notifications-actions.ts" "src/app/(dashboard)/data/notifications-tab.tsx" "src/app/(dashboard)/data/page.tsx" src/components/notifications
git commit -m "feat: Data → Notifications tab — pilot recipients, live preview, send log

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Local QA, changelog and docs

**Files:**
- Modify: `src/lib/changelog.ts`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-30-slack-spend-digests-design.md` (record the Checkpoint A/B outcomes)

- [x] **Step 1: Local QA** (use the `agent-standards:local-qa` skill). Against the local stack with migration 0015 applied, `SLACK_BOT_TOKEN` + `SLACK_PREVIEW_EMAIL` in `.env.local`, and `SLACK_NOTIFY_MODE=preview`:
  1. Give two local employees a manager link: `update employees set manager_ref = (select okta_id from employees where email = '<manager>') where email in ('<report1>', '<report2>');`
  2. On `/data?tab=notifications`, add the manager (weekly + monthly) and one report (daily). The table shows cadences, a report count of 2 for the manager, and Slack "not looked up".
  3. Click Preview for the manager. Expected: header, "YOU" with its own titled chart, "YOUR REPORTS · 2 PEOPLE" with its own chart and linked names, an Open-in-dashboard button. Step ◀ back a week. ▶ disappears at the latest complete week.
  4. **Invariant check (gotcha #2):** switch the preview to monthly for a month with data. The "YOU" total must equal that person's Explore page for the same month (`/explore/<team>/<id>?period=<YYYY-MM>`), to the cent.
  5. Click "Send this to me in Slack". Expected: a DM with the preview banner and both charts rendered inside the message.
  6. Replay a Monday in preview: `curl -s -H "Authorization: Bearer $CRON_SECRET" "localhost:3000/api/cron/notify?date=2026-09-28"`. Expected: JSON with `due` including `weekly:2026-W39`, `sent ≥ 1`, and DMs arriving in *your* Slack with "would send to …". Run it again: `sent: 0` and `alreadyHandled ≥ 1`.
  7. The same curl with `SLACK_NOTIFY_MODE=live` must return **400** (replays are preview-only). Set the mode back afterwards.
  8. The "Recent sends" table lists the preview rows. "Last run" shows today's counts.

- [x] **Step 2: Changelog entry.** Add at the top of `CHANGELOG` in `src/lib/changelog.ts` (use the date of the final commit):
```ts
  {
    date: "2026-10-01",
    title: "Slack spend digests (pilot)",
    items: [
      "Admins can enrol people on the new Data → Notifications tab to get a Slack message with their AI spend — daily, weekly or monthly. Managers also see a section for everyone who reports to them.",
      "Each section comes with a small chart of recent spend by tool. A preview shows exactly what someone would get, and can be sent to yourself first.",
    ],
  },
```

- [x] **Step 3: CLAUDE.md.** Add under "Source-specific notes" (after the Okta bullet):
```markdown
- **Slack digests** (`src/lib/notify/`, spec `docs/superpowers/specs/2026-09-30-slack-spend-digests-design.md`) — `/api/cron/notify` at 07:00 UTC; `SLACK_NOTIFY_MODE` off|preview|live (unset = **off**; preview sends every DM to `SLACK_PREVIEW_EMAIL`). Reporting tree = Okta `managerId` stored raw in `employees.manager_ref`, resolved at read time (`tree.ts`) against okta_id/email/employee_number. `notification_sends` is claim-before-send: never make a row retryable once a DM may have gone out. Daily/weekly headlines are usage (`!isMonthlyLevelFact`); monthly is the total and must match Explore. `?date=` replays are preview-only. `SLACK_BOT_TOKEN` is read only in `notify/wiring.ts`.
```

- [x] **Step 4: Spec follow-ups.** In the spec's §10, record the Checkpoint A numbers (active / resolvable, format mix) and the Checkpoint B result (inline images worked, or the fallback was applied).

- [x] **Step 5: Verify and commit**

Run: `npm run test && npm run lint && CI=true npm run build`
```bash
git add src/lib/changelog.ts CLAUDE.md docs/superpowers/specs/2026-09-30-slack-spend-digests-design.md
git commit -m "docs: Slack digests changelog, CLAUDE.md notes, spec outcomes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [x] **Step 6: Hand back.** Report: the branch state, test count, Checkpoint A/B outcomes, and the go-live steps that need Gareth: apply 0015 to production if not done at Checkpoint A, set the Vercel env (`SLACK_BOT_TOKEN`, `SLACK_NOTIFY_MODE=preview`, `SLACK_PREVIEW_EMAIL`), deploy when he asks, enrol the pilot, review a week of previews, then switch to `live`. **Don't push or deploy without being asked.**
