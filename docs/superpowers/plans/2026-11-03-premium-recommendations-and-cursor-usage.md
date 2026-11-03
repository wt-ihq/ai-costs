# Premium Recommendations and Cursor Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Recommendations page and a Monday Slack DM listing Standard-seat holders whose four-week extra spend beat the step up to Premium, fed by a new Cursor members roster import; plus stored Cursor daily usage shown on the person page and the Cursor page.

**Architecture:** Four shippable phases, each ending in working software: (A) Cursor seat tiers from a roster CSV, with Cursor seat facts priced by tier; (B) a `cursor_daily_usage` table written by the nightly sync and backfilled from Data → Sync, with pure shapers behind admin-only page sections; (C) a pure recommendation rule over `seat_assignments` + `overage` facts, a cached loader and the page; (D) a separate weekly Slack run (`run-recommendations.ts`, modelled on `run-reminders.ts`) with its own recipients table, claim report kind and Notifications panel. Every new read is a new `cached.ts` reader (new keys, so `CACHE_VERSION` stays unless an existing reader's shape changes).

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (PostgREST, paginate every read), vitest, Tailwind v4, Slack Block Kit via the existing `notify/` helpers.

**Spec:** `docs/superpowers/specs/2026-11-03-premium-recommendations-and-cursor-usage-design.md` (mock-ups in `docs/superpowers/specs/mockups/2026-11-03-recommendations/`).

## Global Constraints

- Every `"use server"` action starts with `await requireAdmin()`; every `(dashboard)` page calls `await requireDashboardAccess()` before loading data (`pages.test.ts` enforces it).
- Every Supabase read of a growing table paginates with `.order(...).range(from, from+999)` and a unique tiebreaker (`pageAll` in `notify/store.ts`, `fetchEmployeesAll`, `selectAllRows` in `persist.ts` are the patterns).
- Writes to `spend_facts` or `seat_assignments` from a Server Action call `updateTag(FACTS_TAG)`; from a route handler `revalidateTag(FACTS_TAG, "max")`.
- Migrations are `supabase/migrations/0027_*.sql`, `0028_*.sql`, `0029_*.sql`, each with `enable row level security` and `grant all on public.<table> to service_role`; all three are applied to production before the deploy that uses them.
- Prices: Cursor Standard $40, Premium $120, Free $0 (`seat_prices` rows `cursor:standard`, `cursor:premium`, `cursor:free`; `cursor:teams` stays). Step up = Premium − Standard from `defaultSeatPrice` for the window's month.
- Window = four Monday-to-Sunday weeks ending the most recent Sunday; a week "counts" when its extra spend ≥ step up ÷ 4; flagged when four-week extra > step up; potential saving = extra − step up.
- Copy fixed by the spec: Slack header `Premium seat recommendations`; caveat sentence `Premium would have cost less, it would not have covered all of it.`; empty line `Nobody on a Standard seat is over the line this week`; page column `Last 4 weeks`; tile line `Standard → Premium is +$80 a month`; empty month text `No usage data for this month yet`.
- Cursor usage sections (person page, Cursor page) render only when `requireDashboardAccess()` returns `"admin"`; viewers get neither the sections nor their data.
- Lists in Slack: `• *$951* Name, Team · steady` (amount first, bold, whole dollars via `formatWholeUsd`), max 10 per tool then `… and N more`.
- Tests use made-up names; the admin's Downloads CSV is never a fixture.
- Run `npm run test` and `CI=true npm run build` before each commit that touches ingest or queries. Commit messages end with `Co-Authored-By: Claude Fable 5.1 (1M context) <noreply@anthropic.com>`.
- No PII in git; no production deletes without the admin's explicit go-ahead; deploy only when asked.

## Review Focus

1. A roster row whose email matches no employee, or a roster for a month with no Cursor seat facts yet: the tier is stored only for matched employees and re-pricing touches only facts that exist (Task 4 test "re-prices only matched members' facts for that month").
2. A member whose tier changed within the window (two `seat_assignments` rows, different `period_start`): the latest `period_start` on or before the window's month wins; a later month's row never applies (Task 10 test "latest assignment at or before the month wins").
3. Cursor's daily-usage rows keyed by `date` (epoch ms) instead of `day`: the normalizer still produces the ISO day (Task 5 test "accepts an epoch `date` when `day` is absent").
4. A recipient for whom it is Monday 09:00 local, and a week not ready by Friday: nothing is claimed in either case, and on Monday the new week is the one due (Task 13 tests "waits before 10:30 local" and "an unready week is never claimed; the next Monday moves on").
5. Nobody flagged in a tool, or anywhere: the page shows the empty line per tool and the message still goes out as two lines (Task 12 test "renders the two-line empty message").

---

## Phase A — Cursor seat tiers

### Task 1: Cursor roster CSV parses

**Files:**
- Modify: `src/lib/ingest/parsers/seat-roster.ts`
- Test: `src/lib/ingest/parsers/seat-roster.test.ts`

**Interfaces:**
- Produces: `parseSeatRoster(csv: string): SeatParseResult` unchanged in signature; accepts a `seat type` header as the tier column, skips rows whose Role is `Removed` (case-insensitive), lowercases tiers so Cursor's `Free` becomes `free`.

- [ ] **Step 1: Write the failing tests**

```ts
const cursorCsv = [
  "Name,Email,Role,Seat Type,Included Usage,Free Usage,On-Demand Usage",
  "Ada Example,ada.example@intenthq.com,Member,Standard,$12.00,$0.00,$184.20",
  "Bo Sample,bo.sample@intenthq.com,Team Admin,Premium,$40.00,$0.00,$0.00",
  "Cy Gone,cy.gone@intenthq.com,Removed,Standard,$0.00,$0.00,$0.00",
  "Di Trial,di.trial@intenthq.com,Member,Free,$0.00,$3.10,$0.00",
].join("\n");

it("parses Cursor's members export: Seat Type column, Removed rows skipped, Free kept", () => {
  const { seats, errors } = parseSeatRoster(cursorCsv);
  expect(errors).toEqual([]);
  expect(seats.map((s) => [s.email, s.seatType, s.role])).toEqual([
    ["ada.example@intenthq.com", "standard", "Member"],
    ["bo.sample@intenthq.com", "premium", "Team Admin"],
    ["di.trial@intenthq.com", "free", "Member"],
  ]);
});

it("still requires a tier column under either name", () => {
  expect(parseSeatRoster("Name,Email,Role\nA,a@intenthq.com,Member").errors[0].message).toMatch(/Seat Tier/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/ingest/parsers/seat-roster.test.ts`
Expected: FAIL — "missing required columns" for the Cursor header.

- [ ] **Step 3: Implement** in `seat-roster.ts`: `cTier = idx("seat tier") >= 0 ? idx("seat tier") : idx("seat type")`; skip a row when `cells[cRole]?.toLowerCase() === "removed"`; update the file's doc comment to name the Cursor export shape. Error text stays "missing required columns: Email, Seat Tier (or Seat Type)".

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/ingest/parsers/seat-roster.test.ts`
Expected: PASS (existing Claude/ChatGPT tests included).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/parsers/seat-roster.ts src/lib/ingest/parsers/seat-roster.test.ts
git commit -m "feat(imports): seat roster parser accepts Cursor's members export"
```

### Task 2: Cursor seat facts priced by tier

**Files:**
- Create: `supabase/migrations/0027_cursor_seat_tiers.sql`
- Modify: `src/lib/ingest/seat-months.ts`
- Modify: `src/lib/ingest/normalizers/cursor.ts`
- Modify: `src/lib/ingest/run-cursor.ts:148-200` (`syncCursor`)
- Test: `src/lib/ingest/seat-months.test.ts` (exists? if not, create), `src/lib/ingest/normalizers/cursor.test.ts`

**Interfaces:**
- Produces in `seat-months.ts`:
  - `export type CursorTier = "standard" | "premium" | "free"`
  - `export function pickCursorTier(assignments: { seatType: string; periodStart: string }[], month: string): CursorTier | null` — only rows with `periodStart <= month`; latest wins; unknown tier strings → `"standard"`; no rows at or before → `null` (not a later row).
  - `export async function cursorSeatTiers(supabase: SupabaseClient, month: string): Promise<Map<string, CursorTier>>` — `seat_assignments` where `vendor = 'cursor'`, paginated, through `pickCursorTier`, omitting employees with `null`.
  - `export async function cursorSeatPrices(supabase: SupabaseClient): Promise<Record<CursorTier, number>>` — from `seat_prices` `cursor:*`, defaults `{ standard: 40, premium: 120, free: 0 }` when a row is missing.
- Produces in `normalizers/cursor.ts`: `export function priceCursorSeats(facts: ResolvedFact[], tiers: Map<string, CursorTier>, prices: Record<CursorTier, number>): ResolvedFact[]` — pure; a seat fact whose `employeeId` has a tier gets `costUsd = prices[tier]`, others stay as emitted.
- Consumes: `resolveSeatTiers` untouched.

- [ ] **Step 1: Write the migration**

```sql
-- Cursor seat tiers (spec 2026-11-03-premium-recommendations-and-cursor-usage-design.md).
-- Prices per tier for the Cursor members roster upload; 'teams' stays for existing readers.
insert into seat_prices (vendor, seat_type, monthly_price_usd) values
  ('cursor', 'standard', 40.00),
  ('cursor', 'premium', 120.00),
  ('cursor', 'free', 0.00)
on conflict (vendor, seat_type) do nothing;
```

- [ ] **Step 2: Write the failing tests**

```ts
describe("pickCursorTier", () => {
  it("latest assignment at or before the month wins; a later month never applies", () => {
    const rows = [{ seatType: "premium", periodStart: "2026-09-01" }, { seatType: "standard", periodStart: "2026-11-01" }];
    expect(pickCursorTier(rows, "2026-10-01")).toBe("premium");
    expect(pickCursorTier(rows, "2026-11-01")).toBe("standard");
    expect(pickCursorTier(rows, "2026-08-01")).toBeNull();
  });
  it("knows free; anything unknown is standard", () => {
    expect(pickCursorTier([{ seatType: "free", periodStart: "2026-10-01" }], "2026-10-01")).toBe("free");
    expect(pickCursorTier([{ seatType: "ultra", periodStart: "2026-10-01" }], "2026-10-01")).toBe("standard");
  });
});

describe("priceCursorSeats", () => {
  it("prices seats by the employee's tier and leaves the rest at $40", () => {
    const facts = [seat("e1"), seat("e2"), seat(null)]; // helper: a cursor seat ResolvedFact at $40
    const out = priceCursorSeats(facts, new Map([["e1", "premium"], ["e2", "free"]]), { standard: 40, premium: 120, free: 0 });
    expect(out.map((f) => f.costUsd)).toEqual([120, 0, 40]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/lib/ingest/seat-months.test.ts src/lib/ingest/normalizers/cursor.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 4: Implement** the three functions and wire `syncCursor`: after `attachEmployees`, price each seat fact by its own month (a sync window can span two months): group the seat facts by `day` (already `YYYY-MM-01`), call `cursorSeatTiers(supabase, day)` once per distinct day, then `priceCursorSeats` on that group. Overage facts are untouched. `normalizeCursor` and `normalizeCursorMembers` keep emitting $40.

- [ ] **Step 5: Run the full suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0027_cursor_seat_tiers.sql src/lib/ingest/seat-months.ts src/lib/ingest/seat-months.test.ts src/lib/ingest/normalizers/cursor.ts src/lib/ingest/normalizers/cursor.test.ts src/lib/ingest/run-cursor.ts
git commit -m "feat(cursor): price seat facts by the member's roster tier"
```

### Task 3: Cursor members roster card on Data → Imports

**Files:**
- Modify: `src/lib/ingest/seat-months.ts:12-16` (`TieredVendor`, `isTieredVendor`)
- Modify: `src/app/(dashboard)/imports/actions.ts:398-495` (`previewSeatRoster`, `commitSeatRoster`)
- Modify: `src/app/(dashboard)/data/imports-tab.tsx` (new Cursor section, same `<details>` pattern as lines 124-131)
- Modify: `src/components/seat-roster-import.tsx` (copy only: the Cursor export's column names)
- Test: `src/lib/ingest/seat-months.test.ts`

**Interfaces:**
- `TieredVendor = Extract<Vendor, "chatgpt_business" | "claude_team" | "cursor">`; `isTieredVendor` accepts `"cursor"`.
- Produces: `export async function repriceCursorSeatMonth(supabase: SupabaseClient, month: string): Promise<number>` in `seat-months.ts` — reads the month's `cursor` seat facts (`cost_type = 'seat'`, `day = month`, paginated), applies `cursorSeatTiers` + `cursorSeatPrices` via `priceCursorSeats`, upserts the changed rows with `upsertSpendFacts`, returns the count changed. Pure core, tested: `export function repriceSeatRows<T extends { employeeId: string | null; costUsd: number }>(rows: T[], tiers: Map<string, CursorTier>, prices: Record<CursorTier, number>): { rows: T[]; changed: number }`.
- `commitSeatRoster` for `vendor === "cursor"`: writes `seat_assignments` as today, inserts the `imports` row (`source: 'cursor', kind: 'roster'`), then calls `repriceCursorSeatMonth` instead of `rebuildSeatMonth`.
- `previewSeatRoster` unchanged: prices come from `loadSeatPrices` keys `cursor:standard` etc. (migration 0027).

- [ ] **Step 1: Write the failing test** `it("re-prices only matched members' facts for that month")` for `repriceSeatRows`: three rows (premium employee at 40 → 120, standard at 40 → unchanged, no employee → unchanged) → `changed === 1` and the premium row's `costUsd === 120`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ingest/seat-months.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** `repriceSeatRows`, `repriceCursorSeatMonth`, the `TieredVendor` change, the `commitSeatRoster` branch, and the Imports tab section: a `VendorHeading` "Cursor" with a `<details>` "Seat tiers · only when someone moves between Standard and Premium" whose text reads "Membership and seats sync nightly from Cursor's Admin API, which does not say the tier. Export Members from Cursor's dashboard (Name, Email, Role, Seat Type, …) and upload it to set Standard / Premium / Free per member; it re-prices that month's seats." and `<SeatRosterImport vendor="cursor" />`.

- [ ] **Step 4: Typecheck and build**

Run: `npm run test && CI=true npm run build`
Expected: both pass; the `TieredVendor` widening compiles everywhere (`writeTieredSeatMonth` callers pass only Claude/ChatGPT — if TypeScript complains about `byTier` for `cursor`, narrow those callers' parameter to `Exclude<TieredVendor, "cursor">`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/seat-months.ts src/lib/ingest/seat-months.test.ts src/app/\(dashboard\)/imports/actions.ts src/app/\(dashboard\)/data/imports-tab.tsx src/components/seat-roster-import.tsx
git commit -m "feat(imports): Cursor members roster upload sets seat tiers and re-prices the month"
```

---

## Phase B — Cursor daily usage

### Task 4: Store the daily usage rows

**Files:**
- Create: `supabase/migrations/0028_cursor_daily_usage.sql`
- Modify: `src/lib/ingest/normalizers/cursor.ts:13-20` (`CursorUsageRow`), new `normalizeCursorDailyUsage`
- Modify: `src/lib/ingest/fixtures/cursor-usage.ts` (add the extra fields to the existing rows, plus one row keyed by `date` only)
- Modify: `src/lib/ingest/persist.ts` (new `upsertCursorDailyUsage`, after `upsertCursorTopModels`)
- Modify: `src/lib/ingest/run-cursor.ts` (`syncCursor`, beside the top-model block)
- Test: `src/lib/ingest/normalizers/cursor.test.ts`

**Interfaces:**
- Migration:

```sql
create table cursor_daily_usage (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  entity_key text not null,
  employee_id uuid references employees(id),
  is_active boolean not null default false,
  agent_requests integer not null default 0,
  subscription_included_reqs integer not null default 0,
  usage_based_reqs integer not null default 0,
  api_key_reqs integer not null default 0,
  total_lines_added integer not null default 0,
  total_lines_deleted integer not null default 0,
  accepted_lines_added integer not null default 0,
  accepted_lines_deleted integer not null default 0,
  total_accepts integer not null default 0,
  total_rejects integer not null default 0,
  total_applies integer not null default 0,
  total_tabs_shown integer not null default 0,
  total_tabs_accepted integer not null default 0,
  bugbot_usages integer not null default 0,
  most_used_model text,
  client_version text,
  created_at timestamptz not null default now(),
  unique (day, entity_key)
);
create index cursor_daily_usage_day_idx on cursor_daily_usage (day);
create index cursor_daily_usage_employee_idx on cursor_daily_usage (employee_id);
alter table cursor_daily_usage enable row level security;
grant all on public.cursor_daily_usage to service_role;
```

- `CursorUsageRow` gains optional numbers `agentRequests, subscriptionIncludedReqs, usageBasedReqs, apiKeyReqs, totalLinesAdded, totalLinesDeleted, acceptedLinesAdded, acceptedLinesDeleted, totalAccepts, totalRejects, totalApplies, totalTabsShown, totalTabsAccepted, bugbotUsages` and optional strings `clientVersion`; `date?: number` is already there.
- `export interface CursorDailyUsageRow { day: string; entityKey: string; isActive: boolean; agentRequests: number; subscriptionIncludedReqs: number; usageBasedReqs: number; apiKeyReqs: number; totalLinesAdded: number; totalLinesDeleted: number; acceptedLinesAdded: number; acceptedLinesDeleted: number; totalAccepts: number; totalRejects: number; totalApplies: number; totalTabsShown: number; totalTabsAccepted: number; bugbotUsages: number; mostUsedModel: string | null; clientVersion: string | null }`
- `export function normalizeCursorDailyUsage(raw: CursorUsageResponse): CursorDailyUsageRow[]` — throws `SchemaDriftError` without `data`; day = `row.day` if a string, else `new Date(row.date).toISOString().slice(0,10)` when `date` is a finite number; rows without email or day skipped; later duplicate (day, email) wins; missing numbers 0, `isActive` false.
- `export async function upsertCursorDailyUsage(supabase, rows: (CursorDailyUsageRow & { employeeId: string | null })[]): Promise<number>` — upsert on `day,entity_key` in batches of 1000.
- `syncCursor`: in the same best-effort `try` as top models (or its own), `upsertCursorDailyUsage(supabase, normalizeCursorDailyUsage(raw).map(r => ({ ...r, employeeId: matchIdentity(r.entityKey, employees).employeeId })))`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("normalizeCursorDailyUsage", () => {
  it("maps one row per (day, email) with every counter, zero when absent", () => {
    const rows = normalizeCursorDailyUsage(cursorUsageFixture);
    const ada = rows.find((r) => r.day === "2026-06-01" && r.entityKey === "gareth.jones@intenthq.com")!;
    expect(ada).toMatchObject({ isActive: true, usageBasedReqs: 42, agentRequests: 0, mostUsedModel: "claude-sonnet-4-6" });
  });
  it("accepts an epoch `date` when `day` is absent", () => {
    const rows = normalizeCursorDailyUsage({ data: [{ date: Date.UTC(2026, 5, 3), email: "x@intenthq.com", isActive: true }] });
    expect(rows[0].day).toBe("2026-06-03");
  });
  it("fails loudly on schema drift", () => {
    expect(() => normalizeCursorDailyUsage({} as CursorUsageResponse)).toThrow(SchemaDriftError);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/ingest/normalizers/cursor.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** the normalizer, the persist helper, the fixture additions and the `syncCursor` wiring. Before settling the day key, run this against production once the admin agrees, and read one stored raw payload: `select row->'data'->0 from raw_payloads where source = 'cursor' order by created_at desc limit 1` (via the Supabase MCP, aggregate only). If real rows carry `date` not `day`, nothing changes — the normalizer handles both — but note it in the function's doc comment.

- [ ] **Step 4: Run the suite and build**

Run: `npm run test && CI=true npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0028_cursor_daily_usage.sql src/lib/ingest/normalizers/cursor.ts src/lib/ingest/normalizers/cursor.test.ts src/lib/ingest/fixtures/cursor-usage.ts src/lib/ingest/persist.ts src/lib/ingest/run-cursor.ts
git commit -m "feat(cursor): store per-person daily usage from the nightly sync"
```

### Task 5: "Rebuild Cursor usage" on Data → Sync

**Files:**
- Modify: `src/lib/ingest/run-cursor.ts` (new `rebuildCursorDailyUsage`)
- Modify: `src/app/(dashboard)/imports/actions.ts` (new action after `rebuildCursorMonth`, line ~760)
- Create: `src/components/cursor-usage-rebuild.tsx` (copy of `cursor-rebuild.tsx` calling the new action)
- Modify: `src/app/(dashboard)/data/sync-tab.tsx:17-24` (new section after "Rebuild Cursor on-demand spend")
- Test: `src/lib/ingest/run-cursor.test.ts` (exists; add a case with an injected fetcher)

**Interfaces:**
- `export async function rebuildCursorDailyUsage(supabase: SupabaseClient, window: { startDate: string; endDate: string }, fetcher: CursorFetcher = fetchCursorUsage): Promise<{ rows: number }>` — `fetchUsageInChunks(fetcher, window)` → `normalizeCursorDailyUsage` → `loadEmployees` + `matchIdentity` → `upsertCursorDailyUsage`. No `sync_runs` row, no events, no raw payload save (the payload is already capped and this is a manual rebuild).
- `export async function rebuildCursorUsageMonth(month: unknown): Promise<{ month: string; rows: number }>` — `requireAdmin()`, same month validation and window clamp as `rebuildCursorMonth`, then `updateTag(FACTS_TAG)` and `revalidatePath("/data")`.
- Sync tab copy: heading "Rebuild Cursor usage", text "Re-reads one month of per-person daily usage (active days, agent requests, lines of code) from Cursor's API. Run it once for every month from July 2026 after this update; it's safe to run again."

- [ ] **Step 1: Write the failing test**: with a fetcher returning `cursorUsageFixture` and a stub supabase (follow the existing stubs in `run-cursor.test.ts`), `rebuildCursorDailyUsage` resolves `{ rows: 4 }` and the stub's `cursor_daily_usage` upsert received 4 rows.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ingest/run-cursor.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** the function, the action, the component and the Sync tab section.

- [ ] **Step 4: Run the suite and build**

Run: `npm run test && CI=true npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/run-cursor.ts src/lib/ingest/run-cursor.test.ts src/app/\(dashboard\)/imports/actions.ts src/components/cursor-usage-rebuild.tsx src/app/\(dashboard\)/data/sync-tab.tsx
git commit -m "feat(sync): rebuild a month of Cursor daily usage from Data → Sync"
```

### Task 6: Person page "Cursor usage" section (admin-only)

**Files:**
- Create: `src/lib/cursor-usage/types.ts`, `src/lib/cursor-usage/shape.ts`, `src/lib/cursor-usage/shape.test.ts`
- Create: `src/lib/queries/cursor-usage.ts`
- Modify: `src/lib/queries/cached.ts` (new `getPersonCursorUsageCached(employeeId)`)
- Create: `src/components/cursor-usage/person-usage-panel.tsx` (client: month selector, tiles, weeks chart, hover bubbles)
- Modify: `src/app/(dashboard)/explore/[team]/[person]/page.tsx`

**Interfaces:**
- `types.ts`:

```ts
export interface CursorUsageDay { day: string; employeeId: string | null; entityKey: string; isActive: boolean; agentRequests: number; includedReqs: number; onDemandReqs: number; linesAdded: number; linesDeleted: number; acceptedLinesAdded: number; acceptedLinesDeleted: number; mostUsedModel: string | null }
export interface CursorFactLite { day: string; employeeId: string | null; costType: "seat" | "overage"; costUsd: number }
export interface UsageTiles { activeDays: number; workingDays: number; mostUsedModel: string | null; agentRequests: number; includedReqs: number; onDemandReqs: number; linesKept: number; linesSuggested: number; keptShare: number | null; seatUsd: number; onDemandUsd: number; onDemandFrom: string | null }
export interface UsageWeekDay { day: string; inMonth: boolean; active: boolean; agentRequests: number; onDemandUsd: number }
export interface UsageWeek { monday: string; days: UsageWeekDay[]; requests: number; onDemandUsd: number }
export interface PersonMonthUsage { month: string; tiles: UsageTiles; weeks: UsageWeek[] }
export interface PersonCursorUsageScope { rows: CursorUsageDay[]; facts: CursorFactLite[]; months: string[] } // months with rows, ascending
```

- `shape.ts`:
  - `export function workingDaysIn(month: string): number` — Mon–Fri count.
  - `export function weeksOf(month: string): string[]` — Mondays of every week touching the month.
  - `export function personMonthUsage(scope: PersonCursorUsageScope, month: string): PersonMonthUsage | null` — null when no rows in the month; `linesSuggested = linesAdded + linesDeleted`, `linesKept = acceptedLinesAdded + acceptedLinesDeleted`, `keptShare = linesSuggested ? linesKept / linesSuggested : null`; `mostUsedModel` = the month's most frequent non-null value; `seatUsd` = sum of seat facts that month, `onDemandUsd` = sum of overage facts; `onDemandFrom` = first day with an overage fact or `onDemandReqs > 0`.
- `queries/cursor-usage.ts`: `export async function getPersonCursorUsageScope(supabase, employeeId): Promise<PersonCursorUsageScope>` — all `cursor_daily_usage` rows for the employee (paginated) and `spend_facts` `source = 'cursor'` for the employee.
- Page: `const role = await requireDashboardAccess();` then `const usage = role === "admin" ? await getPersonCursorUsageCached(person) : null;` and render `<PersonUsagePanel scope={usage} />` after `ExploreView` when `usage` is non-null and `usage.months.length > 0`. The panel's month selector defaults to the latest month; a month with no rows shows `No usage data for this month yet`.
- Panel layout per `cursor-usage-v4.html`: four tiles; "Agent requests per day" with one `div` bar per day grouped by week, on-demand days in the second colour, inactive days a 3px grey stub, out-of-month days blank; under each week `<b>5 Oct</b>` then `1,040 requests · $268 on-demand` left-aligned on the next line (`title` attribute on each day bar for the hover). Legend text from the mock-up.

- [ ] **Step 1: Write the failing tests** for `shape.ts`:

```ts
it("counts working days", () => { expect(workingDaysIn("2026-10")).toBe(22); });
it("lists the Mondays of every week touching the month", () => { expect(weeksOf("2026-10")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]); });
it("shapes a month: tiles and weeks", () => {
  const usage = personMonthUsage(scope, "2026-10")!; // fixture: rows on 1, 2, 5 Oct; overage fact $20 on 5 Oct; seat $40
  expect(usage.tiles).toMatchObject({ activeDays: 3, workingDays: 22, agentRequests: 300, linesKept: 90, linesSuggested: 100, keptShare: 0.9, seatUsd: 40, onDemandUsd: 20, onDemandFrom: "2026-10-05" });
  expect(usage.weeks).toHaveLength(5);
  expect(usage.weeks[1]).toMatchObject({ monday: "2026-10-05", requests: 100, onDemandUsd: 20 });
  expect(usage.weeks[0].days[0]).toMatchObject({ day: "2026-09-28", inMonth: false });
});
it("returns null for a month without rows", () => { expect(personMonthUsage(scope, "2026-08")).toBeNull(); });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/cursor-usage/shape.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** types, shapers, query, cached reader, panel and page change.

- [ ] **Step 4: Run tests and build**

Run: `npm run test && CI=true npm run build`
Expected: PASS; `pages.test.ts` still passes (the page keeps `await requireDashboardAccess()`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cursor-usage src/lib/queries/cursor-usage.ts src/lib/queries/cached.ts src/components/cursor-usage/person-usage-panel.tsx src/app/\(dashboard\)/explore/\[team\]/\[person\]/page.tsx
git commit -m "feat(explore): Cursor usage section on the person page (admins)"
```

### Task 7: Cursor page team usage (admin-only)

**Files:**
- Modify: `src/lib/cursor-usage/types.ts`, `src/lib/cursor-usage/shape.ts`, `src/lib/cursor-usage/shape.test.ts`
- Modify: `src/lib/queries/cursor-usage.ts` (new `getTeamCursorUsageScope`)
- Modify: `src/lib/queries/cached.ts` (new `getTeamCursorUsageCached()`)
- Create: `src/components/cursor-usage/team-usage-panel.tsx`
- Modify: `src/components/cursor-models/teams-model-view.tsx` (optional `usage` prop rendered under the period control; the month shown = the month containing the day before `period.toExclusive`)
- Modify: `src/app/(dashboard)/cursor/page.tsx`

**Interfaces:**
- `export interface TeamCursorUsageScope { rows: CursorUsageDay[]; facts: CursorFactLite[]; people: { employeeId: string; name: string; department: string | null; href: string }[] }`
- `export interface TeamMonthUsage { month: string; tiles: { peopleActive: number; seats: number; unusedSeats: number; agentRequests: number; includedReqs: number; onDemandReqs: number; linesKept: number; keptShare: number | null; medianActiveDays: number; workingDays: number }; mostActive: { employeeId; name; href; agentRequests; onDemandUsd }[]; littleUse: { employeeId; name; href; activeDays; seatUsd }[]; littleUseMore: number; unusedSeatsUsd: number }`
- `export function teamMonthUsage(scope: TeamCursorUsageScope, month: string): TeamMonthUsage | null` — null when no rows that month; seats = people with a seat fact that month; `mostActive` top 10 by agent requests; `littleUse` = seat holders with ≤ 1 active day, ascending, first 10, `littleUseMore` the rest; `unusedSeatsUsd` = seat facts of people with 0 active days.
- Query: all `cursor_daily_usage` rows (paginated) + cursor seat/overage facts with `employee_id` + employees `id, full_name, department` for the people in either set; `href` via the Explore person path (`/explore/<department or Unattributed>/<id>` — reuse `personHref("", …)` from `notify/digest.ts`).
- Page: `const role = await requireDashboardAccess();` load `getTeamCursorUsageCached()` only for admins; pass `usage` to `TeamsModelView`, which renders `<TeamUsagePanel usage={teamMonthUsage(usage, month)} month={month} />` (tiles + the two lists from `cursor-usage.html`'s "Cursor page additions"; null → `No usage data for this month yet`).

- [ ] **Step 1: Write the failing test** for `teamMonthUsage`: a fixture of 3 people (one active 20 days with $100 on-demand, one active 1 day, one 0 days, all with $40 seats) → `tiles.peopleActive === 2`, `tiles.unusedSeats === 1`, `mostActive[0].name` is the first, `littleUse.map(p => p.activeDays)` equals `[0, 1]`, `unusedSeatsUsd === 40`, `tiles.medianActiveDays === 1`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/cursor-usage/shape.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** shaper, query, reader, panel, view prop and page.

- [ ] **Step 4: Run tests and build**

Run: `npm run test && CI=true npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cursor-usage src/lib/queries/cursor-usage.ts src/lib/queries/cached.ts src/components/cursor-usage/team-usage-panel.tsx src/components/cursor-models/teams-model-view.tsx src/app/\(dashboard\)/cursor/page.tsx
git commit -m "feat(cursor): team usage tiles, most-active and little-used seats (admins)"
```

---

## Phase C — Recommendations

### Task 8: The rule

**Files:**
- Create: `src/lib/recommendations/rule.ts`, `src/lib/recommendations/rule.test.ts`

**Interfaces (all pure, exported from `rule.ts`):**

```ts
export type RecTool = "cursor" | "claude_team" | "chatgpt_business";
export const REC_TOOLS: readonly RecTool[];
export interface RecWeek { from: string; toExclusive: string }            // Monday, next Monday
export function latestSunday(now: Date): string;                            // UTC; a Sunday returns itself
export function weeksEnding(sunday: string, count: number): RecWeek[];     // oldest first
export type RecTier = "standard" | "premium" | "free" | "unassigned" | "unknown";
export interface RecCandidate { employeeId: string; name: string; department: string | null; tier: RecTier; leaveDate: string | null }
export interface RecSpend { employeeId: string; day: string; costUsd: number }
export interface RecUsage { employeeId: string; day: string; agentRequests: number; isActive: boolean }
export interface RecToolInput { tool: RecTool; stepUpUsd: number; candidates: RecCandidate[]; spend: RecSpend[]; usage?: RecUsage[] }
export type RecPattern = "steady" | "recent" | "one-off" | "on and off";
export interface RecWeekCell extends RecWeek { extraUsd: number; requests: number | null; activeDays: number | null }
export interface RecRow { employeeId: string; name: string; department: string | null; tierUnknown: boolean; extraUsd: number; savingUsd: number; weeks: RecWeekCell[]; pattern: RecPattern; newThisWeek: boolean }
export interface RecToolResult { tool: RecTool; stepUpUsd: number; rows: RecRow[]; premiumCount: number; totalSavingUsd: number }
export function patternWord(weeks: { extraUsd: number }[], stepUpUsd: number): RecPattern;
export function recommend(input: RecToolInput, sunday: string): RecToolResult;
```

Rules inside `recommend`: candidates = input.candidates (tier from the loader) plus any employee in `spend` not among them (tier `"unknown"`); leavers (`leaveDate` non-null) dropped; `premiumCount` = candidates with tier `premium`; eligible tiers `standard` and `unknown`; weeks = `weeksEnding(sunday, 4)`; a row when the four-week sum > `stepUpUsd`; `newThisWeek` = not flagged in `weeksEnding(sunday − 7 days, 4)`; rows sorted by `savingUsd` desc; amounts rounded to cents. `patternWord`: counting = `extraUsd >= stepUpUsd / 4`; ≥3 → steady; all counting weeks within the latest two → recent; exactly one counting week, not the latest → one-off; else on and off.

- [ ] **Step 1: Write the failing tests**

```ts
it("latestSunday: a Tuesday → the Sunday before; a Sunday → itself", () => {
  expect(latestSunday(new Date("2026-11-03T09:00:00Z"))).toBe("2026-11-01");
  expect(latestSunday(new Date("2026-11-01T23:00:00Z"))).toBe("2026-11-01");
});
it("weeksEnding gives four Monday-to-Monday weeks, oldest first", () => {
  expect(weeksEnding("2026-11-01", 4)[0]).toEqual({ from: "2026-10-05", toExclusive: "2026-10-12" });
  expect(weeksEnding("2026-11-01", 4)[3]).toEqual({ from: "2026-10-26", toExclusive: "2026-11-02" });
});
it("patternWord", () => {
  expect(patternWord([{ extraUsd: 30 }, { extraUsd: 30 }, { extraUsd: 30 }, { extraUsd: 5 }], 80)).toBe("steady");
  expect(patternWord([{ extraUsd: 0 }, { extraUsd: 0 }, { extraUsd: 50 }, { extraUsd: 60 }], 80)).toBe("recent");
  expect(patternWord([{ extraUsd: 0 }, { extraUsd: 90 }, { extraUsd: 0 }, { extraUsd: 2 }], 80)).toBe("one-off");
  expect(patternWord([{ extraUsd: 50 }, { extraUsd: 0 }, { extraUsd: 0 }, { extraUsd: 50 }], 80)).toBe("on and off");
});
it("flags Standard holders over the step up, never Premium or Free, and marks unknown tiers", () => {
  // candidates: ada standard, bo premium, cy free; spend: ada $100 in week 3, bo $500, cy $300, dee (no candidate) $90
  const r = recommend(input, "2026-11-01");
  expect(r.rows.map((x) => [x.employeeId, x.savingUsd, x.tierUnknown, x.pattern])).toEqual([["ada", 20, false, "one-off"], ["dee", 10, true, "recent"]]);
  expect(r.premiumCount).toBe(1);
  expect(r.totalSavingUsd).toBe(30);
});
it("newThisWeek is false when the previous window also flagged the person", () => { /* ada with $100 in week 2 as well */ });
it("drops leavers and fills Cursor hover figures from usage", () => { /* leaveDate set → absent; usage rows → weeks[i].requests and activeDays */ });
it("exact step up is not flagged", () => { /* $80 total with stepUp 80 → no row */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/recommendations/rule.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `rule.ts`.** Date arithmetic in UTC with a private `addDays`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/recommendations/rule.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/recommendations
git commit -m "feat(recommendations): pure four-week Premium upgrade rule"
```

### Task 9: Readiness for recommendations

**Files:**
- Modify: `src/lib/notify/readiness.ts`
- Test: `src/lib/notify/readiness.test.ts` (exists)

**Interfaces:**
- `export function recommendationsReadiness(args: Parameters<typeof weekReadiness>[0]): Readiness` — `weekReadiness(args)` with `outstanding` filtered to `kind !== "sync" || source === "cursor"`; `ready = outstanding.length === 0`.

- [ ] **Step 1: Write the failing test**: sync runs where only `openai` and `vercel` are stale and imports current → `recommendationsReadiness(...).ready === true` while `weekReadiness(...).ready === false`; with `cursor` stale → both false and the outstanding item names `cursor`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/notify/readiness.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** (three lines plus a doc comment saying why it is narrower).

- [ ] **Step 4: Run to verify it passes**, then commit:

```bash
git add src/lib/notify/readiness.ts src/lib/notify/readiness.test.ts
git commit -m "feat(notify): readiness check for the recommendations message"
```

### Task 10: Loader and cached reader

**Files:**
- Create: `src/lib/recommendations/load.ts`, `src/lib/recommendations/load.test.ts` (pure parts only)
- Modify: `src/lib/queries/cached.ts` (new `getRecommendationsCached()`)

**Interfaces:**

```ts
export interface RecommendationsData {
  sunday: string; weeks: RecWeek[]; tools: RecToolResult[];
  readiness: Readiness;                      // recommendationsReadiness for the latest week
  rosterAsOf: Partial<Record<RecTool, string>>; // latest imports.kind='roster' data_as_of per vendor
  cursorRosterStale: boolean;               // rosterAsOf.cursor missing or > 35 days before sunday
  departments: string[];                    // of flagged rows, sorted
  updatedAt: string;                        // ISO, when loaded
}
export const ROSTER_STALE_DAYS = 35;
export function latestTierByEmployee(rows: { employeeId: string; seatType: string; periodStart: string }[], month: string): Map<string, RecTier>; // pure: periodStart <= month, latest wins; unknown strings → standard; later-only → absent
export function isRosterStale(asOf: string | undefined, sunday: string): boolean;
export async function loadRecommendations(supabase: SupabaseClient, now: Date): Promise<RecommendationsData>;
```

`loadRecommendations`: `sunday = latestSunday(now)`; `month = sunday.slice(0,7) + "-01"`; spend window = 35 days ending `sunday` inclusive (`[weeksEnding(sunday − 7, 4)[0].from, sunday + 1 day)`); per tool: `stepUpUsd = (await defaultSeatPrice(supabase, vendor, "premium", month)) − (await defaultSeatPrice(supabase, vendor, "standard", month))`; candidates from `seat_assignments` (`vendor`, paginated via `pageAll`) through `latestTierByEmployee`, joined to employees (`fetchEmployeesAll(supabase, "id, full_name, department, leave_date")`); spend from `spend_facts` `source = vendor and cost_type = 'overage' and employee_id is not null` in the window (paginated, `day, employee_id, cost_usd`); Cursor usage from `cursor_daily_usage` in the window; readiness from `supabaseNotifyStore(supabase).recentSyncRuns(readinessSyncSince(now))` and `.manualImports(importsInUseSince(sunday))` with `week = weeksEnding(sunday, 1)[0]`; roster dates from `imports` where `kind = 'roster' and status = 'success'`, max `data_as_of` per source.

- [ ] **Step 1: Write the failing tests** for `latestTierByEmployee` (the Review Focus 2 case: `[premium 2026-09-01, standard 2026-11-01]` at `2026-10-01` → premium; at `2026-08-01` → absent) and `isRosterStale("2026-09-20", "2026-11-01") === true`, `isRosterStale("2026-10-10", "2026-11-01") === false`, `isRosterStale(undefined, …) === true`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/recommendations/load.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `load.ts` and the cached reader (`["recommendations", CACHE_VERSION]`).

- [ ] **Step 4: Run tests and build**

Run: `npm run test && CI=true npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/recommendations/load.ts src/lib/recommendations/load.test.ts src/lib/queries/cached.ts
git commit -m "feat(recommendations): load candidates, spend, step-ups and readiness"
```

### Task 11: The Recommendations page

**Files:**
- Create: `src/app/(dashboard)/recommendations/page.tsx`
- Create: `src/components/recommendations/recommendations-view.tsx` (client: team filter), `src/components/recommendations/week-bars.tsx` (four bars + hover bubble)
- Modify: `src/components/nav.tsx:7-13` (`{ href: "/recommendations", label: "Recommendations" }` after Cursor)
- Modify: `src/lib/changelog.ts` (entry dated the day of the deploy; text in Task 14)

**Interfaces:**
- Page: `await requireDashboardAccess()`, `const data = await getRecommendationsCached()`, `<PageHeader title="Recommendations" subtitle="People on a Standard seat whose extra usage would have paid for Premium." />`, `<RecommendationsView data={data} />`.
- View (per `recommendations-layout-v2.html`): toolbar `Four weeks to Sunday <d Month>` · `Team: <select All | departments>` · right: `Updated <weekday d Mon>, after the weekly sync` or, when `!data.readiness.ready`, `Latest week not ready yet: <outstandingShort(...) joined with ·>`; when `data.cursorRosterStale`: a banner `Cursor seat tiers from <d Mon> — upload a newer members export` (or `No Cursor members export uploaded yet` when absent); three tiles; per tool a heading `<Tool pill> N people` with the source line, then the table with columns Person (link `personHref("", …)`), Team, extra spend header per tool (`On-demand, 4 weeks` / `Extra usage, 4 weeks` / `Credits, 4 weeks`), `Potential saving` bold, `Last 4 weeks` = `<WeekBars cells={row.weeks} tool={tool} />` + pattern word + `new this week` tag; `tier unknown` muted after the name when `tierUnknown`; empty tool → `Nobody on a Standard seat is over the line.`; a tool with no roster ever → `No <tool> roster uploaded yet — tiers unknown.`; footer paragraph from the spec.
- `WeekBars`: heights scaled to the row's max week; each bar's hover bubble `19 to 25 Oct · $184 on-demand` plus, for Cursor, ` · 1,180 requests · 5 active days` (CSS `group-hover`, no JS).

- [ ] **Step 1: Write the page** and components; no new pure logic beyond formatting (use `formatWholeUsd`).

- [ ] **Step 2: Verify the access test and build**

Run: `npm run test && CI=true npm run build`
Expected: PASS; `pages.test.ts` finds the new page and it calls `requireDashboardAccess()`.

- [ ] **Step 3: Run it locally** with `npm run dev` and open `/recommendations` (with `AUTH_DISABLED=true`): tiles, three tool sections, team filter narrows rows, hover shows the bubble.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(dashboard\)/recommendations src/components/recommendations src/components/nav.tsx
git commit -m "feat(dashboard): Recommendations page for Premium seat upgrades"
```

---

## Phase D — Slack message

### Task 12: Recipients table, report kind, message rendering

**Files:**
- Create: `supabase/migrations/0029_recommendations_notifications.sql`
- Modify: `src/lib/notify/types.ts:12` (`SendReport = ReportKind | "reminder" | "recommendations"`)
- Modify: `src/lib/notify/store.ts` (`NotifyStore.recommendationRecipients(): Promise<string[]>`, implemented like `reminderRecipients`; `markOpened` returns `report: Exclude<SendReport, "reminder">` and no longer nulls recommendations)
- Modify: `src/lib/notify/memory-store.ts` (`seed.recommendationRecipients?: string[]`)
- Modify: `src/lib/notify/opens.ts` (`openRedirectPath`: `"recommendations"` → `/recommendations`)
- Modify: `src/lib/notify/admin-store.ts` (`addRecommendationRecipients`, `removeRecommendationRecipient`, `NotificationsAdminData.recommendationRecipients: ReminderRecipientRow[]`, `recommendationPeople: PersonOption[]`)
- Create: `src/lib/notify/render-recommendations.ts`, `src/lib/notify/render-recommendations.test.ts`
- Test: `src/lib/notify/opens.test.ts` (exists? add a case)

**Interfaces:**
- Migration:

```sql
create table if not exists notification_recommendation_recipients (
  employee_id uuid primary key references employees(id) on delete cascade,
  created_by  text not null,
  created_at  timestamptz not null default now()
);
alter table notification_recommendation_recipients enable row level security;
grant all on public.notification_recommendation_recipients to service_role;
alter table notification_sends drop constraint if exists notification_sends_report_check;
alter table notification_sends
  add constraint notification_sends_report_check check (report in ('personal', 'company', 'reminder', 'recommendations'));
```

- `export const REC_LIST_MAX = 10;`
- `export interface RecommendationsMessageInput { data: RecommendationsData; dashboardUrl: string; openUrl?: string; links: boolean; previewFor?: string }`
- `export function renderRecommendations(i: RecommendationsMessageInput): RenderedDigest` — blocks: a header `Premium seat recommendations · four weeks to Sunday <d Month>` (with `HEADER_EMOJI` like the digests); a section with the explanatory line and the totals `N people, $X potential saving a month`; one section per tool `*Cursor · 15 people · Standard → Premium is +$80 a month*` followed by up to `REC_LIST_MAX` items `• *$951* Tom Okafor, Engineering · steady` with ` · new this week` appended when `newThisWeek`, then `… and N more`; a tool with no rows → `*Cursor · nobody over the line*`; nobody anywhere → header + one section `Nobody on a Standard seat is over the line this week`; a context block with the caveat and `Seat tiers from the latest rosters (Cursor export <d Mon>)` (or the stale warning); an actions block with button `Open recommendations` → `openUrl ?? dashboardUrl` when `links`, else no button and names plain. `text` (notification fallback) = `Premium seat recommendations: N people, $X potential saving a month`. `previewFor` prepends the same `Preview for *Name*` context as reminders.

- [ ] **Step 1: Write the failing tests**

```ts
it("renders the full list by tool with amounts first and a tracked button", () => {
  const r = renderRecommendations({ data, dashboardUrl: "https://x/recommendations", openUrl: "https://x/api/digest/open/abc", links: true });
  expect(r.blocks[0]).toMatchObject({ type: "header" });
  expect(JSON.stringify(r.blocks)).toContain("• *$951* Tom Okafor, Engineering · steady");
  expect(JSON.stringify(r.blocks)).toContain("· new this week");
  expect(JSON.stringify(r.blocks)).toContain("… and 12 more");
  expect(r.blocks.at(-1)).toMatchObject({ type: "actions", elements: [{ url: "https://x/api/digest/open/abc" }] });
});
it("renders the two-line empty message", () => {
  const r = renderRecommendations({ data: emptyData, dashboardUrl: "u", links: false });
  expect(r.blocks).toHaveLength(2);
  expect(JSON.stringify(r.blocks)).toContain("Nobody on a Standard seat is over the line this week");
});
it("openRedirectPath sends a recommendations send to /recommendations", async () => { /* memory store with a send report 'recommendations' */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/notify/render-recommendations.test.ts src/lib/notify/opens.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the migration, type, store methods, memory store seed, opens, admin-store functions and data fields (load the list like `reminderRecipients`, lines ~200-242), and the renderer.

- [ ] **Step 4: Run the suite**

Run: `npm run test`
Expected: PASS (existing notify tests unaffected: `everLive` keeps `.in("report", ["personal", "company"])`).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0029_recommendations_notifications.sql src/lib/notify/types.ts src/lib/notify/store.ts src/lib/notify/memory-store.ts src/lib/notify/opens.ts src/lib/notify/opens.test.ts src/lib/notify/admin-store.ts src/lib/notify/render-recommendations.ts src/lib/notify/render-recommendations.test.ts
git commit -m "feat(notify): recommendations recipients, report kind and message"
```

### Task 13: The weekly run

**Files:**
- Create: `src/lib/notify/run-recommendations.ts`, `src/lib/notify/run-recommendations.test.ts`
- Modify: `src/app/api/cron/notify/route.ts:48-53` (after `runReminders`, before `runNotify`)

**Interfaces:**

```ts
export interface RecommendationsRunDeps extends Omit<RunNotifyDeps, "only"> {   // renderChart stays: deliverRendered takes it, and with empty layouts never calls it
  loadData: (now: Date) => Promise<RecommendationsData>;   // cron: (now) => loadRecommendations(supabase, now)
  /** Send now: this week only, today for everyone, optionally forced past readiness or limited to these people. */
  only?: { periodKey: string; force?: boolean; employeeIds?: string[] };
}
export interface RunRecommendationsResult { periodKey: string | null; sent: number; failed: number; alreadyHandled: number; waiting: number; held: string | null; error?: string }
export async function runRecommendations(deps: RecommendationsRunDeps): Promise<RunRecommendationsResult>; // never throws
```

This run is separate from `runNotify` on purpose: `runNotify`'s `only` filter has no report dimension, so keeping recommendations out of it means the existing weekly "Send now", catch-up and Live test never fire this message (the spec's `only.report` concern), and nothing in `run-notify.ts` changes.

Behaviour: recipients = `store.recommendationRecipients()` (filtered by `only.employeeIds`), active employees only; per recipient `day = deps.replay || deps.only ? today : sendDay(now, tz)`; no day → `waiting`; `periodKey = only?.periodKey ?? latestCompleteKey("weekly", at(day))`, `period = periodFor("weekly", periodKey, at(day))`; sends already in `sendStates([periodKey], mode)` with `report === "recommendations"` → `alreadyHandled`; if any remain, `data = await loadData(now)` once (its `sunday` must equal `period.toExclusive − 1 day`, else `held = "data window mismatch"` and nothing is claimed); `ready = data.readiness.ready || only?.force`; not ready → `held = outstandingShort(...).join(" · ")`, nothing claimed; otherwise claim `{ employeeId, cadence: "weekly", periodKey, mode, report: "recommendations" }` via `claim(...)`, `links = canOpenDashboard(recipient.email)` from `loadDashboardAccess(store, deps.adminEmails, log)`, `deliverRendered({ slack, renderChart: unused stub, slackUserId, layouts: {}, render: () => renderRecommendations({ data, dashboardUrl: `${baseUrl}/recommendations`, openUrl: `${baseUrl}/api/digest/open/${sendId}`, links, previewFor }) })`, `finishSend(key, { status: "sent", slackTs, dashboardLink: links })`; failures contained exactly like `run-reminders.ts` (`PostOutcomeUnknownError` → `interrupted` detail). Preview mode sends to `previewEmail`'s employee with `previewFor` set.

- [ ] **Step 1: Write the failing tests** with `memoryStore` and a fake Slack (follow `run-reminders.test.ts`):

```ts
it("sends the latest week to each recipient on a working day from 10:30 local and claims it", …); // now = Monday 10:45 London → sent 1, store.sends[0] has report "recommendations", cadence "weekly", dashboard_link true
it("waits before 10:30 local", …);                            // Monday 09:00 → waiting 1, no sends
it("an unready week is never claimed; the next Monday moves on", …); // readiness not ready Fri → held, sends 0; next Monday → periodKey is the new week
it("never sends twice", …);                                   // run twice → second run alreadyHandled 1
it("only: sends now for the given week and people, forced past readiness", …);
it("loader failure is contained", …);                         // loadData rejects → error set, failed 1, no claim
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/notify/run-recommendations.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `run-recommendations.ts` and the cron wiring: `const recommendations = await runRecommendations({ ...deps, loadData: (now) => loadRecommendations(supabase, now) });` and include it in the JSON result.

- [ ] **Step 4: Run the suite and build**

Run: `npm run test && CI=true npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notify/run-recommendations.ts src/lib/notify/run-recommendations.test.ts src/app/api/cron/notify/route.ts
git commit -m "feat(notify): Monday recommendations DM once the week is ready"
```

### Task 14: Notifications panel, preview, Send now, changelog

**Files:**
- Modify: `src/app/(dashboard)/data/notifications-actions.ts` (new actions)
- Create: `src/components/notifications/recommendations-panel.tsx` (client: recipients add/remove with the catch-up checkbox, status line, Send now / Send anyway, link to preview)
- Modify: `src/app/(dashboard)/data/notifications-tab.tsx` (`NotificationsParams.recommendations?: string`; a `<Panel>` after the reminder recipients; when `params.recommendations === "1"` render the message via `BlockKitPreview` from `renderRecommendations({ data: await getRecommendationsCached(), dashboardUrl, links: true })`)
- Modify: `src/lib/changelog.ts`

**Interfaces (actions, each `await requireAdmin()` first):**
- `export async function addRecommendationRecipient(employeeId: string, sendLatest: boolean): Promise<{ added: number; sent?: RunRecommendationsResult }>` — insert via `addRecommendationRecipients`; when `sendLatest`, `runRecommendations({ ...deps, only: { periodKey: latestCompleteKey("weekly", now), employeeIds: [employeeId] } })` using the same deps builder as `sendNowDeps()` plus `loadData`; `revalidatePath("/data")`.
- `export async function removeRecommendationRecipientAction(employeeId: string): Promise<void>`.
- `export async function sendRecommendationsNow(force: boolean, expectedMode: string): Promise<{ ok: true; result: RunRecommendationsResult } | { ok: false; error: string }>` — refuses when the stored mode differs from `expectedMode` (`MODE_CHANGED`) or is `off`.
- Panel status line: `Week <label> · ready` or `· waiting for <outstanding>` (from `getRecommendationsCached().readiness`), `N recipients · M sent` (from `sendStates([key], mode)` filtered to `report === "recommendations"`), buttons `Send now` (disabled when not ready unless `Send anyway`), and a link `Preview` → `/data?tab=notifications&recommendations=1`.
- Changelog entry (newest first), title "Premium seat recommendations and Cursor usage", items in plain language: the Recommendations page and what it lists; the Cursor members export upload and that Premium Cursor seats now count at $120 from the month it is uploaded; the Monday Slack message and where to pick recipients; the Cursor usage section on a person's page and the Cursor page (admins); the Data → Sync "Rebuild Cursor usage" and the July–now backfill.

- [ ] **Step 1: Implement** the actions, panel, tab wiring and changelog entry.

- [ ] **Step 2: Run everything**

Run: `npm run lint && npm run test && CI=true npm run build`
Expected: all pass.

- [ ] **Step 3: Run locally** (`npm run dev`, `AUTH_DISABLED=true`): Data → Notifications shows the Recommendations panel; Preview renders the message; adding a person lists them.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(dashboard\)/data/notifications-actions.ts src/components/notifications/recommendations-panel.tsx src/app/\(dashboard\)/data/notifications-tab.tsx src/lib/changelog.ts
git commit -m "feat(notifications): recommendations recipients, preview and Send now"
```

### Task 15: Deployment notes (no code)

- [ ] Apply migrations 0027, 0028, 0029 to production (Supabase MCP `apply_migration`, only when the admin says so), in order, before merging.
- [ ] After deploy: Data → Sync → "Rebuild Cursor usage" for every month July 2026 → current; Data → Imports → upload the Cursor members export (as-of today); Data → Notifications → add recommendation recipients and Preview the message; eyeball the Cursor page's "People active" against Cursor's dashboard once.
- [ ] Update `CLAUDE.md` (Source-specific notes: Cursor tiers from the roster, `cursor_daily_usage`, the recommendations run and its narrower readiness) and the memory index.
