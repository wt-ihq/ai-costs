# Claude Seats: Okta Sync, Tier Overlay, GBP Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude seat facts sync nightly from the Okta `access-claude` group with a standard/premium tier overlay; historical months are backfillable per tier in £; the latest entry's price becomes the default price everywhere (both vendors).

**Architecture:** Migration 0007 adds `seat_type` + `price_gbp`/`fx_rate` to `seat_month_entries` (key `(vendor, month, seat_type)`). The seat funnel generalizes: `computeSeatFacts` gains source/unassigned-key options, `computeClaudeSeatFacts` runs it per tier, `defaultSeatPrice` unifies the price chain (latest entry → `seat_prices` → constant). A new `claude_seats` cron source mirrors `chatgpt_seats` plus tier resolution from `seat_assignments`; the roster CSV becomes a tier-refresher; the monthly-seats card gains a vendor selector with £ entry for Claude.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Supabase, Okta API.

**Spec:** `docs/superpowers/specs/2026-07-14-claude-seats-okta-and-backfill-design.md`

## Global Constraints

- Branch off origin/main: `git checkout -b claude-seats-okta origin/main`.
- All facts stay **USD**; Claude entries are made in £ and converted at save time: `price_usd = round(price_gbp × fx_rate × 100)/100`.
- **Default-price chain (both vendors):** latest `seat_month_entries` row for (vendor, seatType) by month desc → `seat_prices` row → constant (`chatgpt_business:chatgpt` 25, `claude_team:standard` 19.05, `claude_team:premium` 95.25).
- Manual entries are authoritative (count × price = the tier's monthly total); members distribute; extras become unassigned. Cent-exact per tier.
- Claude unassigned keys: `"unassigned seats (standard)"` / `"unassigned seats (premium)"`; ChatGPT keeps `"unassigned seats"`. All unassigned filtering uses the prefix `unassigned seats`.
- Tier default is **standard** (unknown members, unmatched emails, missing assignments).
- Gotchas #1 (paginate growing-table reads, unique tiebreaker) and #4 (no delete-then-insert on possibly-empty; surgical unassigned-only removal) hold everywhere.
- Every `"use server"` action starts with `await requireAdmin()`.
- Sync sources: `"claude_seats"` (new) beside `"chatgpt_seats"`; both fold into their vendor's Data Health row.
- ChatGPT behavior must be regression-free (existing entries get `seat_type='chatgpt'`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Final: `npm run test && CI=true npm run build` pass. Do NOT merge/push/deploy; migration 0007 must be applied to prod (by Gareth) before deploy.

---

### Task 1: migration 0007 + tier-aware pure compute

**Files:**
- Create: `supabase/migrations/0007_seat_month_entries_tiers.sql`
- Modify: `src/lib/ingest/seat-months.ts`
- Test: `src/lib/ingest/seat-months.test.ts`

**Interfaces:**
- Consumes: existing `computeSeatFacts(month, entry, members, defaultPriceUsd)`, `UNASSIGNED_SEATS_KEY`, `SeatMonthEntry`, `SeatMember`.
- Produces (used by Tasks 2–6):

```ts
export const UNASSIGNED_PREFIX = "unassigned seats";           // all unassigned keys start with this
export type ClaudeTier = "standard" | "premium";
export const CLAUDE_UNASSIGNED_KEY: Record<ClaudeTier, string>; // "unassigned seats (standard)" / "(premium)"
export interface SeatFactOpts { source: Vendor; unassignedKey: string }
export function computeSeatFacts(
  month: string, entry: SeatMonthEntry | null, members: SeatMember[], defaultPriceUsd: number,
  opts?: Partial<SeatFactOpts>,   // defaults { source: "chatgpt_business", unassignedKey: UNASSIGNED_SEATS_KEY }
): ResolvedFact[];
export interface TierInput { seatType: ClaudeTier; entry: SeatMonthEntry | null; members: SeatMember[]; defaultPriceUsd: number }
export function computeClaudeSeatFacts(month: string, tiers: TierInput[]): ResolvedFact[];
```

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0007_seat_month_entries_tiers.sql
-- Per-tier monthly entries (Claude standard/premium) + GBP audit trail.
-- Existing ChatGPT rows keep working via the 'chatgpt' default.
alter table seat_month_entries
  add column seat_type text not null default 'chatgpt',
  add column price_gbp numeric,   -- Claude: price as entered (£); ChatGPT: null
  add column fx_rate   numeric;   -- £→$ rate used at save time; ChatGPT: null
alter table seat_month_entries drop constraint seat_month_entries_vendor_month_key;
alter table seat_month_entries add unique (vendor, month, seat_type);
```

- [ ] **Step 2: Write the failing tests** (append to `seat-months.test.ts`; reuse its existing `MONTH`/`members` helpers)

```ts
import { computeClaudeSeatFacts, CLAUDE_UNASSIGNED_KEY } from "./seat-months";

describe("computeSeatFacts with source/unassignedKey opts", () => {
  it("stamps the given source and unassigned key", () => {
    const facts = computeSeatFacts(MONTH, { seats: 2, priceUsd: 19.05 }, [], 19.05, {
      source: "claude_team",
      unassignedKey: CLAUDE_UNASSIGNED_KEY.standard,
    });
    expect(facts).toEqual([
      expect.objectContaining({ source: "claude_team", entityKey: "unassigned seats (standard)", costUsd: 38.1 }),
    ]);
  });

  it("defaults remain ChatGPT (regression)", () => {
    const facts = computeSeatFacts(MONTH, { seats: 1, priceUsd: 25 }, [], 25);
    expect(facts[0]).toMatchObject({ source: "chatgpt_business", entityKey: "unassigned seats" });
  });
});

describe("computeClaudeSeatFacts", () => {
  const std = [{ entityKey: "a@x.com", employeeId: "e1" }, { entityKey: "b@x.com", employeeId: null }];
  const prem = [{ entityKey: "c@x.com", employeeId: "e3" }];

  it("computes per tier with distinct unassigned keys, cent-exact per tier", () => {
    const facts = computeClaudeSeatFacts(MONTH, [
      { seatType: "standard", entry: { seats: 3, priceUsd: 19.05 }, members: std, defaultPriceUsd: 19.05 },
      { seatType: "premium", entry: { seats: 2, priceUsd: 95.25 }, members: prem, defaultPriceUsd: 95.25 },
    ]);
    // standard: 2 members at 19.05 + remainder (3-2)×19.05; premium: 1 member + 1 unassigned
    expect(facts.filter((f) => f.source === "claude_team")).toHaveLength(facts.length);
    expect(facts.find((f) => f.entityKey === CLAUDE_UNASSIGNED_KEY.standard)?.costUsd).toBe(19.05);
    expect(facts.find((f) => f.entityKey === CLAUDE_UNASSIGNED_KEY.premium)?.costUsd).toBe(95.25);
    const total = Math.round(facts.reduce((s, f) => s + f.costUsd * 100, 0));
    expect(total).toBe(Math.round((3 * 19.05 + 2 * 95.25) * 100)); // 5715 + 19050
  });

  it("no entries: each tier's members at that tier's default price", () => {
    const facts = computeClaudeSeatFacts(MONTH, [
      { seatType: "standard", entry: null, members: std, defaultPriceUsd: 19.05 },
      { seatType: "premium", entry: null, members: prem, defaultPriceUsd: 95.25 },
    ]);
    expect(facts.find((f) => f.entityKey === "a@x.com")?.costUsd).toBe(19.05);
    expect(facts.find((f) => f.entityKey === "c@x.com")?.costUsd).toBe(95.25);
    expect(facts.filter((f) => f.entityKey.startsWith("unassigned seats"))).toHaveLength(0);
  });

  it("returns [] only when every tier yields [] (zero totals, no members)", () => {
    expect(computeClaudeSeatFacts(MONTH, [
      { seatType: "standard", entry: { seats: 0, priceUsd: 19.05 }, members: [], defaultPriceUsd: 19.05 },
      { seatType: "premium", entry: null, members: [], defaultPriceUsd: 95.25 },
    ])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify RED** — `npx vitest run src/lib/ingest/seat-months.test.ts` fails on the new imports.

- [ ] **Step 4: Implement** in `seat-months.ts`:

```ts
import type { Vendor } from "@/lib/types";   // extend the existing types import

export const UNASSIGNED_PREFIX = "unassigned seats";
export type ClaudeTier = "standard" | "premium";
export const CLAUDE_UNASSIGNED_KEY: Record<ClaudeTier, string> = {
  standard: "unassigned seats (standard)",
  premium: "unassigned seats (premium)",
};
export interface SeatFactOpts { source: Vendor; unassignedKey: string }
```

Change `computeSeatFacts`'s signature to add `opts?: Partial<SeatFactOpts>` and inside it:

```ts
  const { source = "chatgpt_business", unassignedKey = UNASSIGNED_SEATS_KEY } = opts ?? {};
```

Replace the hardcoded `source: "chatgpt_business"` in the `fact` helper with `source`, and both `UNASSIGNED_SEATS_KEY` usages inside the function with `unassignedKey`. Then append:

```ts
export interface TierInput {
  seatType: ClaudeTier;
  entry: SeatMonthEntry | null;
  members: SeatMember[];
  defaultPriceUsd: number;
}

/** Claude month = the single-tier computation per tier, concatenated. */
export function computeClaudeSeatFacts(month: string, tiers: TierInput[]): ResolvedFact[] {
  return tiers.flatMap((t) =>
    computeSeatFacts(month, t.entry, t.members, t.defaultPriceUsd, {
      source: "claude_team",
      unassignedKey: CLAUDE_UNASSIGNED_KEY[t.seatType],
    }),
  );
}
```

- [ ] **Step 5: GREEN + suite** — `npx vitest run src/lib/ingest/seat-months.test.ts && npx vitest run`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0007_seat_month_entries_tiers.sql src/lib/ingest/seat-months.ts src/lib/ingest/seat-months.test.ts
git commit -m "feat: tier-aware seat_month_entries + per-tier Claude seat computation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: I/O generalization + the default-price chain

**Files:**
- Modify: `src/lib/ingest/seat-months.ts`, `src/lib/ingest/run-chatgpt-seats.ts`
- Test: `src/lib/ingest/seat-months.test.ts` (fake-supabase test for the LIKE-prefix delete)

**Interfaces:**
- Produces (used by Tasks 3–6):

```ts
export async function getSeatMonthEntry(supabase, month, vendor: Vendor = "chatgpt_business", seatType = "chatgpt"): Promise<SeatMonthEntry | null>;
export async function replaceSeatMonth(supabase, month, facts, source: Vendor = "chatgpt_business"): Promise<number>;
export async function readSeatMonthMembers(supabase, source: Vendor, month): Promise<SeatMember[]>;
export const SEAT_PRICE_FALLBACK: Record<string, number>; // "vendor:seatType" → constant
export async function defaultSeatPrice(supabase, vendor: Vendor, seatType: string): Promise<number>;
// rebuildChatGptSeatMonth(supabase, month) — defaultPriceUsd param REMOVED, resolved internally via defaultSeatPrice
```

- [ ] **Step 1: Modify `getSeatMonthEntry`** — add the two params with defaults; add `.eq("vendor", vendor).eq("seat_type", seatType)` to the query (replacing the hardcoded vendor eq).

- [ ] **Step 2: Modify `replaceSeatMonth`** — add `source: Vendor = "chatgpt_business"` as the 4th param; use it in both the empty-path delete and the `replaceWindowFacts` call; the empty-path delete changes from `.eq("entity_key", UNASSIGNED_SEATS_KEY)` to `.like("entity_key", `${UNASSIGNED_PREFIX}%`)` (covers all three unassigned keys).

- [ ] **Step 3: Extract `readSeatMonthMembers`** — the paginated member read currently inside `rebuildChatGptSeatMonth`, parameterized by `source`, with the exclusion changed from `.neq("entity_key", UNASSIGNED_SEATS_KEY)` to `.not("entity_key", "like", `${UNASSIGNED_PREFIX}%`)`. `rebuildChatGptSeatMonth` calls it.

- [ ] **Step 4: Add the price chain**

```ts
/** "vendor:seatType" → hardcoded floor when neither an entry nor seat_prices exists. */
export const SEAT_PRICE_FALLBACK: Record<string, number> = {
  "chatgpt_business:chatgpt": 25,
  "claude_team:standard": 19.05,
  "claude_team:premium": 95.25,
};

/**
 * The default per-seat price for months WITHOUT their own entry: the latest
 * entry's price (most recent month, any vendor month), else seat_prices, else
 * the constant. Entering a new price in any month moves this default.
 */
export async function defaultSeatPrice(supabase: SupabaseClient, vendor: Vendor, seatType: string): Promise<number> {
  const { data: latest, error: e1 } = await supabase
    .from("seat_month_entries")
    .select("price_usd")
    .eq("vendor", vendor)
    .eq("seat_type", seatType)
    .order("month", { ascending: false })
    .limit(1);
  if (e1) throw new Error(`defaultSeatPrice entries: ${e1.message}`);
  if (latest?.[0]) return Number(latest[0].price_usd);

  const { data: priced, error: e2 } = await supabase
    .from("seat_prices")
    .select("monthly_price_usd")
    .eq("vendor", vendor)
    .eq("seat_type", seatType)
    .limit(1);
  if (e2) throw new Error(`defaultSeatPrice seat_prices: ${e2.message}`);
  if (priced?.[0]) return Number(priced[0].monthly_price_usd);

  return SEAT_PRICE_FALLBACK[`${vendor}:${seatType}`] ?? 0;
}
```

- [ ] **Step 5: Rewire consumers**
- `rebuildChatGptSeatMonth(supabase, month)` — drop the `defaultPriceUsd` param; resolve internally: `const defaultPriceUsd = await defaultSeatPrice(supabase, "chatgpt_business", "chatgpt");`
- `syncChatGptSeats` (`run-chatgpt-seats.ts`) — replace the inline `seat_prices` query block (lines 49-56) with `const defaultPrice = await defaultSeatPrice(supabase, "chatgpt_business", "chatgpt");`
- `saveSeatMonthEntry`/`deleteSeatMonthEntry` in `src/app/(dashboard)/imports/actions.ts` — drop their `loadSeatPrices` lines and call `rebuildChatGptSeatMonth(supabase, day)` (2 args). (These actions are further rewritten in Task 6 — make only the signature-compat change here so the build stays green.)

- [ ] **Step 6: Add a fake-supabase test** asserting the empty-facts path deletes by LIKE-prefix (seed a `"unassigned seats (standard)"` fact for `claude_team`, call `replaceSeatMonth(client, MONTH, [], "claude_team")`, assert it was removed while a member fact survives). Model the fake on the existing `fakeSpendFactsDb` in `persist.test.ts`, adding a `like`-aware delete chain: `.delete().eq(...).like("entity_key", pattern)` — pattern `%` maps to `startsWith` for the prefix case.

- [ ] **Step 7: Verify + commit**

`npx vitest run && npx tsc --noEmit && npm run lint`

```bash
git add src/lib/ingest/seat-months.ts src/lib/ingest/seat-months.test.ts src/lib/ingest/run-chatgpt-seats.ts src/app/\(dashboard\)/imports/actions.ts
git commit -m "feat: unified default-price chain + multi-vendor seat month I/O

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Claude tier resolution

**Files:**
- Modify: `src/lib/ingest/seat-months.ts`
- Test: `src/lib/ingest/seat-months.test.ts`

**Interfaces:**
- Produces:

```ts
export function pickTier(assignments: { seatType: string; periodStart: string }[], month: string): ClaudeTier; // pure
export async function resolveClaudeTiers(supabase, month): Promise<Map<string, ClaudeTier>>; // employee_id → tier
```

- [ ] **Step 1: Failing tests (pure part)**

```ts
describe("pickTier", () => {
  const a = (seatType: string, periodStart: string) => ({ seatType, periodStart });
  it("picks the assignment with the greatest period_start ≤ the month", () => {
    expect(pickTier([a("standard", "2026-01-01"), a("premium", "2026-04-01"), a("standard", "2026-08-01")], "2026-06-01")).toBe("premium");
  });
  it("falls back to the latest assignment when all are after the month", () => {
    expect(pickTier([a("premium", "2026-08-01"), a("standard", "2026-09-01")], "2026-06-01")).toBe("standard");
  });
  it("defaults to standard with no assignments or unknown tier strings", () => {
    expect(pickTier([], "2026-06-01")).toBe("standard");
    expect(pickTier([a("unassigned", "2026-01-01")], "2026-06-01")).toBe("standard");
  });
});
```

- [ ] **Step 2: RED**, then **Step 3: implement**

```ts
/** premium only when the winning assignment says so; anything else is standard. */
export function pickTier(assignments: { seatType: string; periodStart: string }[], month: string): ClaudeTier {
  if (assignments.length === 0) return "standard";
  const atOrBefore = assignments.filter((x) => x.periodStart <= month);
  const pool = atOrBefore.length ? atOrBefore : assignments;
  const winner = pool.reduce((best, x) => (x.periodStart > best.periodStart ? x : best));
  return winner.seatType === "premium" ? "premium" : "standard";
}

/** employee_id → tier for a month, from seat_assignments (paginated, gotcha #1). */
export async function resolveClaudeTiers(supabase: SupabaseClient, month: string): Promise<Map<string, ClaudeTier>> {
  const byEmployee = new Map<string, { seatType: string; periodStart: string }[]>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("seat_assignments")
      .select("employee_id, seat_type, period_start")
      .eq("vendor", "claude_team")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`resolveClaudeTiers: ${error.message}`);
    for (const r of data ?? []) {
      if (!r.employee_id) continue;
      const list = byEmployee.get(r.employee_id as string) ?? [];
      list.push({ seatType: r.seat_type as string, periodStart: r.period_start as string });
      byEmployee.set(r.employee_id as string, list);
    }
    if (!data || data.length < PAGE) break;
  }
  return new Map([...byEmployee.entries()].map(([id, list]) => [id, pickTier(list, month)]));
}
```

- [ ] **Step 4: GREEN + suite**, then **Step 5: Commit**

```bash
git add src/lib/ingest/seat-months.ts src/lib/ingest/seat-months.test.ts
git commit -m "feat: Claude tier resolution from seat_assignments

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `claude_seats` sync + rebuild + Data Health

**Files:**
- Create: `src/lib/ingest/run-claude-seats.ts`
- Modify: `src/lib/ingest/seat-months.ts` (add `rebuildClaudeSeatMonth`), `src/lib/ingest/run-all.ts`, `src/lib/queries/data-health.ts`

**Interfaces:**
- Consumes: `fetchOktaGroupMembers`, `toSeatMembers` (exported by `run-chatgpt-seats.ts`), Tasks 1–3 exports.
- Produces:

```ts
// run-claude-seats.ts
export const CLAUDE_OKTA_GROUP = "access-claude";
export async function syncClaudeSeats(supabase, fetcher?: OktaGroupFetcher): Promise<{ rowsWritten: number }>;
// seat-months.ts
export async function rebuildClaudeSeatMonth(supabase, month): Promise<number>; // members from stored facts, tiers re-resolved
```

- [ ] **Step 1: Add `rebuildClaudeSeatMonth` to seat-months.ts**

```ts
/**
 * Rebuild a Claude month after an entry change or roster (tier) upload:
 * members from the month's stored seat facts, tiers re-resolved, entries
 * authoritative per tier.
 */
export async function rebuildClaudeSeatMonth(supabase: SupabaseClient, month: string): Promise<number> {
  const members = await readSeatMonthMembers(supabase, "claude_team", month);
  const tiers = await resolveClaudeTiers(supabase, month);
  const byTier: Record<ClaudeTier, SeatMember[]> = { standard: [], premium: [] };
  for (const m of members) byTier[m.employeeId ? tiers.get(m.employeeId) ?? "standard" : "standard"].push(m);

  const tierInputs: TierInput[] = [];
  for (const seatType of ["standard", "premium"] as const) {
    tierInputs.push({
      seatType,
      entry: await getSeatMonthEntry(supabase, month, "claude_team", seatType),
      members: byTier[seatType],
      defaultPriceUsd: await defaultSeatPrice(supabase, "claude_team", seatType),
    });
  }
  return replaceSeatMonth(supabase, month, computeClaudeSeatFacts(month, tierInputs), "claude_team");
}
```

- [ ] **Step 2: Create the orchestrator** (mirror `run-chatgpt-seats.ts` exactly — same try/catch, `startSyncRun(supabase, "claude_seats")`, `saveRawPayload`, current-UTC-month):

```ts
// src/lib/ingest/run-claude-seats.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOktaGroupMembers, type OktaGroupFetcher } from "@/lib/ingest/sources/okta";
import { finishSyncRun, loadEmployees, saveRawPayload, startSyncRun } from "@/lib/ingest/persist";
import { toSeatMembers } from "@/lib/ingest/run-chatgpt-seats";
import {
  computeClaudeSeatFacts, defaultSeatPrice, getSeatMonthEntry, replaceSeatMonth, resolveClaudeTiers,
  type ClaudeTier, type SeatMember, type TierInput,
} from "@/lib/ingest/seat-months";

/** The Okta group whose membership defines who holds a Claude seat. */
export const CLAUDE_OKTA_GROUP = "access-claude";

/**
 * Claude seats from Okta: refresh the CURRENT UTC month, tier per member from
 * seat_assignments (default standard). Same snapshot/authority/gotcha-#4
 * semantics as chatgpt_seats.
 */
export async function syncClaudeSeats(
  supabase: SupabaseClient,
  fetcher: OktaGroupFetcher = fetchOktaGroupMembers,
): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "claude_seats");
  try {
    const groupMembers = await fetcher(CLAUDE_OKTA_GROUP);
    await saveRawPayload(supabase, "claude_seats", runId, { group: CLAUDE_OKTA_GROUP, members: groupMembers });

    const month = new Date().toISOString().slice(0, 7) + "-01";
    const employees = await loadEmployees(supabase);
    const members = toSeatMembers(groupMembers.map((m) => m.email), employees);
    const tiers = await resolveClaudeTiers(supabase, month);
    const byTier: Record<ClaudeTier, SeatMember[]> = { standard: [], premium: [] };
    for (const m of members) byTier[m.employeeId ? tiers.get(m.employeeId) ?? "standard" : "standard"].push(m);

    const tierInputs: TierInput[] = [];
    for (const seatType of ["standard", "premium"] as const) {
      tierInputs.push({
        seatType,
        entry: await getSeatMonthEntry(supabase, month, "claude_team", seatType),
        members: byTier[seatType],
        defaultPriceUsd: await defaultSeatPrice(supabase, "claude_team", seatType),
      });
    }

    const rowsWritten = await replaceSeatMonth(supabase, month, computeClaudeSeatFacts(month, tierInputs), "claude_team");
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
```

- [ ] **Step 3: Register + surface**
- `run-all.ts`: import `syncClaudeSeats`; add `run("claude_seats", () => syncClaudeSeats(supabase)),` to the parallel block.
- `data-health.ts`: add `"claude_seats"` to the sync-run source list (beside `"chatgpt_seats"`), and generalize `syncFor` — replace the chatgpt-only special case with:

```ts
  const SEAT_SYNC: Partial<Record<Vendor, string>> = { chatgpt_business: "chatgpt_seats", claude_team: "claude_seats" };
  function syncFor(source: Vendor): { at: string | null; status: string } | undefined {
    const direct = lastSync.get(source);
    const seatsKey = SEAT_SYNC[source];
    const seats = seatsKey ? lastSync.get(seatsKey) : undefined;
    if (!direct) return seats;
    if (!seats) return direct;
    return (seats.at ?? "") >= (direct.at ?? "") ? seats : direct;
  }
```

(Keep the explanatory comment above it, updated to name both seat syncs.)

- [ ] **Step 4: Empty-group no-wipe regression test** — create `src/lib/ingest/run-claude-seats.test.ts` mirroring the existing `syncChatGptSeats` empty-fetcher test in `src/lib/ingest/run-chatgpt-seats.test.ts` (read it and reuse/adapt its stateful fake-supabase harness, extending the fake's chains for `seat_assignments` select→eq→order→range → empty and the `like`-style delete): seed one existing `claude_team` member seat fact for the current month, run `syncClaudeSeats` with an injected fetcher returning `[]`, and assert the member fact SURVIVES (gotcha #4) while the run completes successfully. This is a regression lock — expected to pass immediately; note that in the test comment.

- [ ] **Step 5: Verify + commit** — `npx vitest run && npx tsc --noEmit && npm run lint`

```bash
git add src/lib/ingest/run-claude-seats.ts src/lib/ingest/run-claude-seats.test.ts src/lib/ingest/seat-months.ts src/lib/ingest/run-all.ts src/lib/queries/data-health.ts
git commit -m "feat: claude_seats cron source — seats from the Okta access-claude group

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: roster CSV becomes tier-refresher

**Files:**
- Modify: `src/app/(dashboard)/imports/actions.ts` (`commitClaudeRoster`), `src/app/(dashboard)/imports/page.tsx` (roster panel copy)

**Interfaces:** `commitClaudeRoster(rows, asOf)` signature/return unchanged (`{ written, seats, attributed }`; `written` now = rebuilt fact count).

- [ ] **Step 1: Rewrite the commit body** — in `commitClaudeRoster` (actions.ts): delete the snapshot delete (`.delete().eq("source","claude_team").eq("cost_type","seat").eq("day", day)`), delete the `facts` construction and `upsertSpendFacts` call. Keep the empty-rows guard, `seat_assignments` upsert, and imports log. After the assignments upsert, add:

```ts
  // Tier changes re-price the month immediately; membership itself comes from
  // the nightly claude_seats sync (entries stay authoritative when present).
  const written = await rebuildClaudeSeatMonth(supabase, day);
```

Import `rebuildClaudeSeatMonth` from seat-months (extend the existing import line). If `upsertSpendFacts` loses its last actions.ts caller, remove it from the persist import (grep first — `commitClaudeSpendImport` may still use it; verify, don't assume).

- [ ] **Step 2: Panel copy** — the "Claude Team — roster (seats)" panel in page.tsx becomes:

```tsx
          <h2 className="mb-1 text-sm font-medium">Claude Team — roster (seat tiers)</h2>
          <p className="mb-4 text-xs text-muted">
            Membership syncs nightly from the Okta <strong>access-claude</strong> group. Upload the roster CSV
            (Name, Email, Role, Status, Seat Tier) only when someone&rsquo;s tier changes — it updates
            standard/premium assignments and re-prices the current month.
          </p>
```

- [ ] **Step 3: Verify + commit** — `npx vitest run && npx tsc --noEmit && npm run lint && CI=true npm run build`

```bash
git add src/app/\(dashboard\)/imports/actions.ts src/app/\(dashboard\)/imports/page.tsx
git commit -m "feat: Claude roster upload is a tier-refresher (seats sync from Okta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: save/delete actions — vendor, tier, £

**Files:**
- Modify: `src/app/(dashboard)/imports/actions.ts`

**Interfaces:**
- Produces (used by Task 7):

```ts
export interface SeatEntryInput {
  seatType: string;        // 'chatgpt' | 'standard' | 'premium'
  seats: number;
  price: number;           // USD for chatgpt_business; £ for claude_team
}
export async function saveSeatMonthEntries(
  month: string,           // YYYY-MM
  vendor: "chatgpt_business" | "claude_team",
  inputs: SeatEntryInput[],// 1 row for ChatGPT, up to 2 (standard/premium) for Claude
  fxRate: number | null,   // required > 0 for claude_team; null for chatgpt
): Promise<{ written: number }>;
export async function deleteSeatMonthEntry(
  month: string, vendor: "chatgpt_business" | "claude_team", seatType: string,
): Promise<{ written: number }>;
```

- [ ] **Step 1: Replace the two existing actions** (the singular ChatGPT-only `saveSeatMonthEntry` and vendor-hardcoded `deleteSeatMonthEntry`) with:

```ts
export interface SeatEntryInput {
  seatType: string; // 'chatgpt' | 'standard' | 'premium'
  seats: number;
  price: number; // USD for chatgpt_business, £ for claude_team
}

const VALID_TIERS: Record<string, string[]> = {
  chatgpt_business: ["chatgpt"],
  claude_team: ["standard", "premium"],
};

async function rebuildSeatMonth(supabase: SupabaseClient, vendor: string, day: string): Promise<number> {
  return vendor === "claude_team" ? rebuildClaudeSeatMonth(supabase, day) : rebuildChatGptSeatMonth(supabase, day);
}

/** Save a month's authoritative entries (per tier), then rebuild its facts. Claude prices are £ × fxRate. */
export async function saveSeatMonthEntries(
  month: string,
  vendor: "chatgpt_business" | "claude_team",
  inputs: SeatEntryInput[],
  fxRate: number | null,
): Promise<{ written: number }> {
  await requireAdmin();
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month "${month}" — expected YYYY-MM.`);
  if (!inputs.length) throw new Error("Nothing to save — no tier rows.");
  const isClaude = vendor === "claude_team";
  if (isClaude && (!Number.isFinite(fxRate) || (fxRate as number) <= 0)) throw new Error("A £→$ rate > 0 is required for Claude.");
  const supabase = getSupabaseAdminClient();
  const day = `${month}-01`;

  const rows = inputs.map((i) => {
    if (!VALID_TIERS[vendor].includes(i.seatType)) throw new Error(`Invalid tier "${i.seatType}" for ${vendor}.`);
    if (!Number.isInteger(i.seats) || i.seats < 0) throw new Error("Seats must be a whole number ≥ 0.");
    if (!Number.isFinite(i.price) || i.price < 0) throw new Error("Price must be a number ≥ 0.");
    // Round to cents post-conversion: sub-cent prices break cent-exactness.
    const priceUsd = Math.round((isClaude ? i.price * (fxRate as number) : i.price) * 100) / 100;
    return {
      vendor,
      month: day,
      seat_type: i.seatType,
      seats: i.seats,
      price_usd: priceUsd,
      price_gbp: isClaude ? i.price : null,
      fx_rate: isClaude ? fxRate : null,
      updated_at: new Date().toISOString(),
    };
  });

  const { error } = await supabase.from("seat_month_entries").upsert(rows, { onConflict: "vendor,month,seat_type" });
  if (error) throw new Error(`saveSeatMonthEntries: ${error.message}`);

  const written = await rebuildSeatMonth(supabase, vendor, day);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
}

/** Delete one tier's entry for a month and revert its facts to members × default price. */
export async function deleteSeatMonthEntry(
  month: string,
  vendor: "chatgpt_business" | "claude_team",
  seatType: string,
): Promise<{ written: number }> {
  await requireAdmin();
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month "${month}" — expected YYYY-MM.`);
  const supabase = getSupabaseAdminClient();
  const day = `${month}-01`;

  const { error } = await supabase
    .from("seat_month_entries")
    .delete()
    .eq("vendor", vendor)
    .eq("month", day)
    .eq("seat_type", seatType);
  if (error) throw new Error(`deleteSeatMonthEntry: ${error.message}`);

  const written = await rebuildSeatMonth(supabase, vendor, day);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
}
```

Extend the seat-months import line with `rebuildClaudeSeatMonth`. (The Task 7 component is the only caller of the old names — the build breaks between Tasks 6 and 7 ONLY if the component isn't updated; do Step 2 to keep it green.)

- [ ] **Step 2: Temporary component shim** — in `src/components/seat-month-entries.tsx`, update the two call sites to the new signatures so the build stays green (`saveSeatMonthEntries(month, "chatgpt_business", [{ seatType: "chatgpt", seats: Number(seats), price: Number(price) || 0 }], null)` and `deleteSeatMonthEntry(m, "chatgpt_business", "chatgpt")`). Task 7 rewrites this component fully.

- [ ] **Step 3: Verify + commit** — `npx vitest run && npx tsc --noEmit && npm run lint`

```bash
git add src/app/\(dashboard\)/imports/actions.ts src/components/seat-month-entries.tsx
git commit -m "feat: per-tier seat entries with GBP conversion for Claude

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: monthly seats card — vendor selector + £ entry

**Files:**
- Modify: `src/components/seat-month-entries.tsx`, `src/app/(dashboard)/imports/page.tsx`

**Interfaces:**
- Consumes: `saveSeatMonthEntries` / `deleteSeatMonthEntry` (Task 6).
- Produces: `SeatMonthEntryRow` gains `vendor: string; seatType: string; priceGbp: number | null; fxRate: number | null`.

- [ ] **Step 1: page.tsx** — widen the entries fetch (drop the vendor filter, add the new columns, raise the limit):

```ts
  const { data: seatMonths } = await supabase
    .from("seat_month_entries")
    .select("vendor, seat_type, month, seats, price_usd, price_gbp, fx_rate")
    .order("month", { ascending: false })
    .limit(72);
  const seatEntries: SeatMonthEntryRow[] = (seatMonths ?? []).map((r) => ({
    vendor: r.vendor as string,
    seatType: r.seat_type as string,
    month: (r.month as string).slice(0, 7),
    seats: Number(r.seats),
    priceUsd: Number(r.price_usd),
    priceGbp: r.price_gbp === null ? null : Number(r.price_gbp),
    fxRate: r.fx_rate === null ? null : Number(r.fx_rate),
  }));
```

Update the panel heading to "Monthly seats (ChatGPT & Claude)" and its copy:

```tsx
          <p className="mb-4 text-xs text-muted">
            The authoritative seat counts and prices for a month — synced members share the entered totals,
            extra seats show as &ldquo;unassigned seats&rdquo;. ChatGPT is priced in $; Claude in £ (converted
            at your rate). The most recent entry&rsquo;s price becomes the default for later months without
            their own entry. Removing an entry reverts that tier to synced members × default price.
          </p>
```

- [ ] **Step 2: Rewrite the component.** Structure (keep the existing styling classes, `useTransition`, error/success panes, month input with its hydration comment):

```tsx
export interface SeatMonthEntryRow {
  vendor: string;   // 'chatgpt_business' | 'claude_team'
  seatType: string; // 'chatgpt' | 'standard' | 'premium'
  month: string;    // YYYY-MM
  seats: number;
  priceUsd: number;
  priceGbp: number | null;
  fxRate: number | null;
}
```

State: `vendor` (`"chatgpt_business" | "claude_team"`, default chatgpt, a `<select>`), `month`, and per-tier `seats`/`price` strings plus a single `rate` string for Claude.

Prefill helpers (client-side, from the `entries` prop — newest first, so `find` returns the latest):

```tsx
  const latest = (v: string, t: string) => entries.find((e) => e.vendor === v && e.seatType === t);
  const FALLBACK: Record<string, { price: string; rate: string }> = {
    "chatgpt_business:chatgpt": { price: "25", rate: "" },
    "claude_team:standard": { price: "15", rate: "1.27" },
    "claude_team:premium": { price: "75", rate: "1.27" },
  };
  const prefillPrice = (v: string, t: string) => {
    const e = latest(v, t);
    if (!e) return FALLBACK[`${v}:${t}`].price;
    return String(v === "claude_team" ? e.priceGbp ?? e.priceUsd : e.priceUsd);
  };
  const prefillRate = () => String(latest("claude_team", "standard")?.fxRate ?? latest("claude_team", "premium")?.fxRate ?? 1.27);
```

On vendor change and on month change: load the selected month's saved entries when they exist (seats + price + rate), else the prefill chain above with seats blank.

Save handler:

```tsx
  const onSave = () =>
    run(async () => {
      const isClaude = vendor === "claude_team";
      const inputs = isClaude
        ? [
            { seatType: "standard", seats: Number(stdSeats), price: Number(stdPrice) || 0 },
            { seatType: "premium", seats: Number(premSeats), price: Number(premPrice) || 0 },
          ].filter((i) => Number.isFinite(i.seats) && String(i.seats) !== "NaN")
        : [{ seatType: "chatgpt", seats: Number(seats), price: Number(price) || 0 }];
      const { written } = await saveSeatMonthEntries(month, vendor, inputs, isClaude ? Number(rate) || 0 : null);
      setSaved(`Saved ${month} — ${written} facts written.`);
    });
```

(For Claude, submit only tiers whose seats field is non-blank: filter on `stdSeats.trim() !== ""` etc. — a blank tier is left untouched, a `0` pins it to zero.)

Entries table columns: Month · Vendor · Tier · Seats · Price (for Claude show `£15.00 → $19.05`; ChatGPT `$25.00`) · Total (`seats × priceUsd`) · remove (calls `deleteSeatMonthEntry(e.month, e.vendor, e.seatType)`). Vendor label via `VENDOR_LABEL`.

- [ ] **Step 3: Verify + commit** — `npx vitest run && npx tsc --noEmit && npm run lint && CI=true npm run build`

```bash
git add src/components/seat-month-entries.tsx src/app/\(dashboard\)/imports/page.tsx
git commit -m "feat: vendor-aware monthly seats card with £ entry for Claude

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: changelog + full verification

**Files:**
- Modify: `src/lib/changelog.ts`

- [ ] **Step 1: Prepend** (new first entry):

```ts
  {
    date: "2026-07-14",
    title: "Claude seats join the party",
    items: [
      "Claude seat members now sync nightly from Okta (the access-claude group), with each person's standard or premium tier applied automatically — the roster CSV is only needed when a tier changes.",
      "You can backfill any month's Claude seat costs per tier, entered in £ with your exchange rate (stored alongside the $ conversion).",
      "The most recent price you enter becomes the default seat price for later months — for both Claude and ChatGPT.",
    ],
  },
```

- [ ] **Step 2: Full verify** — `npm run test && npm run lint && CI=true npm run build` all pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/changelog.ts
git commit -m "docs: changelog for Okta-synced Claude seats and GBP backfill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand back** — do NOT merge/push/deploy. Remind the user: (1) **migration 0007 must be applied to prod first** (dashboard SQL editor); (2) after deploy, trigger a manual sync and check Data Health — the Claude Team row should show a `claude_seats` run (loud failure if the Okta token can't read `access-claude`); (3) backfill historical Claude months from the £ invoices.
