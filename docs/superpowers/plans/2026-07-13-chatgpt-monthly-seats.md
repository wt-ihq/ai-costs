# Manual Monthly ChatGPT Seat Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins enter a monthly ChatGPT seat count + per-seat price (default $25, per-month override); the entry is the authoritative monthly total and the paste import only distributes attribution.

**Architecture:** A new `seat_month_entries` table stores one (vendor, month, seats, price) row. A pure `computeSeatFacts` function produces the month's full seat-fact set from (entry, members, default price); both the manual-entry save and the paste commit funnel through it plus a seat-scoped month replace, so the two inputs converge regardless of order.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres/PostgREST), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-13-chatgpt-monthly-seats-design.md`

## Global Constraints

- Branch off origin/main: `git checkout -b chatgpt-monthly-seats origin/main`. (PR #17, the fractional-quantities fix, is open and also touches `src/lib/changelog.ts` — if it merges first, re-merge main and keep both changelog items.)
- Every `"use server"` action must call `await requireAdmin()` first.
- All windows are exclusive-end `[startDate, endDate)`; seat facts are always stamped `YYYY-MM-01`, so a month's window is `[YYYY-MM-01, YYYY-MM-02)`.
- Never delete-then-insert when the insert might be empty (gotcha #4). The one intentional-removal case (entry deleted, no members) uses a surgical single-key delete, not a window wipe.
- Any read of a growing table must paginate with a unique tiebreaker (gotcha #1); single-row `.limit(1)` lookups are exempt.
- Seat facts: `source: "chatgpt_business"`, `costType: "seat"`, `model` omitted (defaults to `""` in the DB).
- Default seat price: `seat_prices["chatgpt_business:chatgpt"] ?? 25`.
- **Money math in cents:** a month's fact set must sum to exactly `round(seats × price × 100)` cents whenever an entry exists.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Before the final commit: `npm run test` and `CI=true npm run build` must pass.

---

### Task 1: migration + pure `computeSeatFacts`

**Files:**
- Create: `supabase/migrations/0006_seat_month_entries.sql`
- Create: `src/lib/ingest/seat-months.ts`
- Test: `src/lib/ingest/seat-months.test.ts`

**Interfaces:**
- Consumes: `ResolvedFact` from `@/lib/ingest/persist`.
- Produces (used by Tasks 2–3):

```ts
export const UNASSIGNED_SEATS_KEY = "unassigned seats";
export interface SeatMonthEntry { seats: number; priceUsd: number }
export interface SeatMember { entityKey: string; employeeId: string | null }
export function computeSeatFacts(
  month: string,                    // YYYY-MM-01
  entry: SeatMonthEntry | null,
  members: SeatMember[],
  defaultPriceUsd: number,
): ResolvedFact[];
```

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0006_seat_month_entries.sql
-- Manual monthly seat entries: the authoritative seats × price total for a
-- month. The paste import only distributes attribution across people.
create table seat_month_entries (
  id          uuid primary key default gen_random_uuid(),
  vendor      vendor not null,
  month       date not null,           -- always YYYY-MM-01
  seats       integer not null check (seats >= 0),
  price_usd   numeric not null check (price_usd >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (vendor, month)
);
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/ingest/seat-months.test.ts
import { describe, expect, it } from "vitest";
import { computeSeatFacts, UNASSIGNED_SEATS_KEY } from "./seat-months";

const MONTH = "2026-06-01";
const members = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ entityKey: `person ${i + 1}`, employeeId: i === 0 ? "e1" : null }));

const total = (facts: { costUsd: number }[]) =>
  Math.round(facts.reduce((s, f) => s + f.costUsd * 100, 0)); // cents, avoids float noise

describe("computeSeatFacts", () => {
  it("no entry: members at the default price (today's behavior), no unassigned fact", () => {
    const facts = computeSeatFacts(MONTH, null, members(3), 25);
    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.costUsd === 25 && f.costType === "seat" && f.day === MONTH)).toBe(true);
    expect(facts.find((f) => f.entityKey === UNASSIGNED_SEATS_KEY)).toBeUndefined();
    expect(facts[0].employeeId).toBe("e1"); // attribution preserved
  });

  it("entry with no members: one unassigned fact of seats × price", () => {
    const facts = computeSeatFacts(MONTH, { seats: 27, priceUsd: 25 }, [], 25);
    expect(facts).toEqual([
      expect.objectContaining({ entityKey: UNASSIGNED_SEATS_KEY, costUsd: 675, employeeId: null }),
    ]);
  });

  it("entry with fewer members than seats: members at price + unassigned remainder", () => {
    const facts = computeSeatFacts(MONTH, { seats: 23, priceUsd: 25 }, members(20), 99);
    expect(facts).toHaveLength(21);
    expect(facts.filter((f) => f.entityKey !== UNASSIGNED_SEATS_KEY).every((f) => f.costUsd === 25)).toBe(true);
    expect(facts.find((f) => f.entityKey === UNASSIGNED_SEATS_KEY)?.costUsd).toBe(75); // (23-20) × 25
    expect(total(facts)).toBe(57500); // exactly 23 × $25
  });

  it("entry with members == seats: no unassigned fact", () => {
    const facts = computeSeatFacts(MONTH, { seats: 3, priceUsd: 30 }, members(3), 25);
    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.costUsd === 30)).toBe(true);
  });

  it("entry with MORE members than seats: total split evenly, cent-exact", () => {
    // 20 seats × $25 = $500.00 over 23 members: 22 × $21.73 + 1 × $21.94
    const facts = computeSeatFacts(MONTH, { seats: 20, priceUsd: 25 }, members(23), 25);
    expect(facts).toHaveLength(23);
    expect(facts.find((f) => f.entityKey === UNASSIGNED_SEATS_KEY)).toBeUndefined();
    expect(total(facts)).toBe(50000); // exactly 20 × $25
    expect(facts.slice(0, 22).every((f) => f.costUsd === 21.73)).toBe(true);
    expect(facts[22].costUsd).toBe(21.94); // last row absorbs the rounding remainder
  });

  it("entry priced per month overrides the default", () => {
    const facts = computeSeatFacts(MONTH, { seats: 2, priceUsd: 20 }, members(2), 25);
    expect(facts.every((f) => f.costUsd === 20)).toBe(true);
  });

  it("zero-total entry with no members yields no facts (caller removes any stale unassigned fact)", () => {
    expect(computeSeatFacts(MONTH, { seats: 0, priceUsd: 25 }, [], 25)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/ingest/seat-months.test.ts`
Expected: FAIL — cannot resolve `./seat-months`.

- [ ] **Step 4: Write the implementation**

```ts
// src/lib/ingest/seat-months.ts
import type { ResolvedFact } from "@/lib/ingest/persist";

/** Entity key for seats paid for but not attributed to a pasted member. */
export const UNASSIGNED_SEATS_KEY = "unassigned seats";

export interface SeatMonthEntry {
  seats: number;
  priceUsd: number;
}

export interface SeatMember {
  entityKey: string; // normalized display name (paste) — matches existing seat-fact keys
  employeeId: string | null;
}

/**
 * The full seat-fact set for one month. When a manual entry exists it is
 * AUTHORITATIVE: the facts always sum to exactly seats × price (in cents).
 * Members (from the paste) only distribute attribution:
 *   - no entry            → members × default price (legacy behavior)
 *   - entry, no members   → one "unassigned seats" fact for the whole total
 *   - entry, M ≤ seats    → members at price, remainder unassigned
 *   - entry, M > seats    → total split evenly across members, cent-exact
 *                           (last member absorbs the rounding remainder)
 * Returns [] only for a zero-total entry with no members — the caller must
 * then remove any stale unassigned fact surgically (never a window wipe).
 */
export function computeSeatFacts(
  month: string,
  entry: SeatMonthEntry | null,
  members: SeatMember[],
  defaultPriceUsd: number,
): ResolvedFact[] {
  const fact = (entityKey: string, costUsd: number, employeeId: string | null): ResolvedFact => ({
    source: "chatgpt_business",
    day: month,
    costType: "seat",
    entityKey,
    costUsd,
    employeeId,
  });

  if (!entry) return members.map((m) => fact(m.entityKey, defaultPriceUsd, m.employeeId));

  const totalCents = Math.round(entry.seats * entry.priceUsd * 100);
  const count = members.length;

  if (count === 0) return totalCents > 0 ? [fact(UNASSIGNED_SEATS_KEY, totalCents / 100, null)] : [];

  if (count <= entry.seats) {
    const memberCents = Math.round(entry.priceUsd * 100);
    const facts = members.map((m) => fact(m.entityKey, memberCents / 100, m.employeeId));
    const remainderCents = totalCents - memberCents * count;
    if (remainderCents > 0) facts.push(fact(UNASSIGNED_SEATS_KEY, remainderCents / 100, null));
    return facts;
  }

  // More members than seats: manual count wins — split the total evenly.
  const perCents = Math.floor(totalCents / count);
  return members.map((m, i) => {
    const cents = i === count - 1 ? totalCents - perCents * (count - 1) : perCents;
    return fact(m.entityKey, cents / 100, m.employeeId);
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/ingest/seat-months.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0006_seat_month_entries.sql src/lib/ingest/seat-months.ts src/lib/ingest/seat-months.test.ts
git commit -m "feat: seat_month_entries table + authoritative computeSeatFacts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: I/O helpers + save/delete server actions

**Files:**
- Modify: `src/lib/ingest/seat-months.ts` (append I/O helpers)
- Modify: `src/app/(dashboard)/imports/actions.ts` (new actions)

**Interfaces:**
- Consumes: `computeSeatFacts`, `SeatMonthEntry`, `SeatMember`, `UNASSIGNED_SEATS_KEY` (Task 1); `replaceWindowFacts` from `@/lib/ingest/persist`; `requireAdmin`, `getSupabaseAdminClient`, `loadSeatPrices` (already in actions.ts).
- Produces (used by Tasks 3–4):

```ts
// seat-months.ts
export async function getSeatMonthEntry(supabase: SupabaseClient, month: string): Promise<SeatMonthEntry | null>;
export async function replaceSeatMonth(supabase: SupabaseClient, month: string, facts: ResolvedFact[]): Promise<number>;
export async function rebuildChatGptSeatMonth(supabase: SupabaseClient, month: string, defaultPriceUsd: number): Promise<number>;
// actions.ts
export async function saveSeatMonthEntry(month: string /* YYYY-MM */, seats: number, priceUsd: number): Promise<{ written: number }>;
export async function deleteSeatMonthEntry(month: string /* YYYY-MM */): Promise<{ written: number }>;
```

- [ ] **Step 1: Append I/O helpers to seat-months.ts**

Add imports at the top:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { replaceWindowFacts } from "@/lib/ingest/persist";
```

(Change the existing `import type { ResolvedFact } ...` line to import both: `import { replaceWindowFacts, type ResolvedFact } from "@/lib/ingest/persist";`)

Append:

```ts
/** The month's manual entry, if one has been saved. Single row — no pagination needed. */
export async function getSeatMonthEntry(
  supabase: SupabaseClient,
  month: string, // YYYY-MM-01
): Promise<SeatMonthEntry | null> {
  const { data, error } = await supabase
    .from("seat_month_entries")
    .select("seats, price_usd")
    .eq("vendor", "chatgpt_business")
    .eq("month", month)
    .limit(1);
  if (error) throw new Error(`getSeatMonthEntry: ${error.message}`);
  const row = data?.[0];
  return row ? { seats: Number(row.seats), priceUsd: Number(row.price_usd) } : null;
}

/**
 * Replace one month's ChatGPT seat facts (seat-scoped — overage/credits are
 * never touched). An empty fact set is the intentional zero case: remove only
 * a leftover unassigned fact, surgically (gotcha #4: no window wipe).
 */
export async function replaceSeatMonth(
  supabase: SupabaseClient,
  month: string, // YYYY-MM-01
  facts: ResolvedFact[],
): Promise<number> {
  if (facts.length === 0) {
    const { error } = await supabase
      .from("spend_facts")
      .delete()
      .eq("source", "chatgpt_business")
      .eq("cost_type", "seat")
      .eq("day", month)
      .eq("entity_key", UNASSIGNED_SEATS_KEY);
    if (error) throw new Error(`replaceSeatMonth: ${error.message}`);
    return 0;
  }
  // Seat facts are always stamped YYYY-MM-01, so a one-day window covers the month.
  const window = { startDate: month, endDate: month.slice(0, 8) + "02" };
  return replaceWindowFacts(supabase, "chatgpt_business", window, facts, { costType: "seat" });
}

/**
 * Rebuild a month's seat facts after a manual-entry change. Members come from
 * the month's existing member seat facts (i.e. the latest paste); the paste
 * commit itself passes fresh members directly instead.
 */
export async function rebuildChatGptSeatMonth(
  supabase: SupabaseClient,
  month: string, // YYYY-MM-01
  defaultPriceUsd: number,
): Promise<number> {
  const entry = await getSeatMonthEntry(supabase, month);

  const members: SeatMember[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("entity_key, employee_id")
      .eq("source", "chatgpt_business")
      .eq("cost_type", "seat")
      .eq("day", month)
      .neq("entity_key", UNASSIGNED_SEATS_KEY)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`rebuildChatGptSeatMonth: ${error.message}`);
    for (const r of data ?? []) {
      members.push({ entityKey: r.entity_key as string, employeeId: (r.employee_id as string) ?? null });
    }
    if (!data || data.length < PAGE) break;
  }

  return replaceSeatMonth(supabase, month, computeSeatFacts(month, entry, members, defaultPriceUsd));
}
```

- [ ] **Step 2: Add the server actions**

In `src/app/(dashboard)/imports/actions.ts`, add the import:

```ts
import { rebuildChatGptSeatMonth } from "@/lib/ingest/seat-months";
```

Add after the ChatGPT paste section:

```ts
// ---- ChatGPT monthly seat entries (manual count × price) --------------------

const MONTH_RE = /^\d{4}-\d{2}$/;

/** Save (upsert) a month's authoritative seat count × price, then rebuild its facts. */
export async function saveSeatMonthEntry(
  month: string, // YYYY-MM from the month picker
  seats: number,
  priceUsd: number,
): Promise<{ written: number }> {
  await requireAdmin();
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month "${month}" — expected YYYY-MM.`);
  if (!Number.isInteger(seats) || seats < 0) throw new Error("Seats must be a whole number ≥ 0.");
  if (!Number.isFinite(priceUsd) || priceUsd < 0) throw new Error("Price must be a number ≥ 0.");
  const supabase = getSupabaseAdminClient();
  const day = `${month}-01`;

  const { error } = await supabase
    .from("seat_month_entries")
    .upsert(
      { vendor: "chatgpt_business", month: day, seats, price_usd: priceUsd, updated_at: new Date().toISOString() },
      { onConflict: "vendor,month" },
    );
  if (error) throw new Error(`saveSeatMonthEntry: ${error.message}`);

  const defaultPrice = (await loadSeatPrices(supabase))["chatgpt_business:chatgpt"] ?? 25;
  const written = await rebuildChatGptSeatMonth(supabase, day, defaultPrice);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
}

/** Delete a month's manual entry and revert its facts to pasted-members × default price. */
export async function deleteSeatMonthEntry(month: string): Promise<{ written: number }> {
  await requireAdmin();
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month "${month}" — expected YYYY-MM.`);
  const supabase = getSupabaseAdminClient();
  const day = `${month}-01`;

  const { error } = await supabase
    .from("seat_month_entries")
    .delete()
    .eq("vendor", "chatgpt_business")
    .eq("month", day);
  if (error) throw new Error(`deleteSeatMonthEntry: ${error.message}`);

  const defaultPrice = (await loadSeatPrices(supabase))["chatgpt_business:chatgpt"] ?? 25;
  const written = await rebuildChatGptSeatMonth(supabase, day, defaultPrice);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
}
```

- [ ] **Step 3: Verify**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all pass (no new unit tests — these are Supabase plumbing over the tested `computeSeatFacts`, consistent with the sibling import actions).

- [ ] **Step 4: Commit**

```bash
git add src/lib/ingest/seat-months.ts src/app/\(dashboard\)/imports/actions.ts
git commit -m "feat: save/delete monthly seat entries with seat-fact rebuild

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: paste commit funnels through `computeSeatFacts`

**Files:**
- Modify: `src/app/(dashboard)/imports/actions.ts` — `commitChatGptImport` only

**Interfaces:**
- Consumes: `computeSeatFacts`, `getSeatMonthEntry`, `replaceSeatMonth`, `SeatMember` from `@/lib/ingest/seat-months` (Tasks 1–2).
- Produces: `commitChatGptImport(rows, asOf)` — signature and `ChatGptCommitResult` unchanged; behavior with no manual entry unchanged.

- [ ] **Step 1: Refactor the seat-fact block**

Add to the seat-months import in actions.ts:

```ts
import { rebuildChatGptSeatMonth, getSeatMonthEntry, replaceSeatMonth, computeSeatFacts, type SeatMember } from "@/lib/ingest/seat-months";
```

In `commitChatGptImport`, replace this block (current shape — from the seat-scoped delete through the `upsertSpendFacts` call):

```ts
  // Snapshot semantics: clear this month's ChatGPT *seat* facts only — overage
  // now comes from the credit-usage CSV import and must never be clobbered here.
  await supabase.from("spend_facts").delete().eq("source", "chatgpt_business").eq("cost_type", "seat").eq("day", day);

  const empId = (r: ChatGptPreviewRow) => (r.confidence === "high" ? r.employeeId : null);

  // Every listed member holds a seat.
  const seatFacts: ResolvedFact[] = rows.map((r) => ({
    source: "chatgpt_business",
    day,
    costType: "seat",
    entityKey: normalizeName(r.name),
    costUsd: seatPrice,
    employeeId: empId(r),
  }));

  const written = await upsertSpendFacts(supabase, seatFacts);
```

with:

```ts
  const empId = (r: ChatGptPreviewRow) => (r.confidence === "high" ? r.employeeId : null);

  // Every listed member holds a seat; the month's manual entry (when present)
  // is authoritative for the total — computeSeatFacts prices/splits/tops-up.
  const members: SeatMember[] = rows.map((r) => ({ entityKey: normalizeName(r.name), employeeId: empId(r) }));
  const entry = await getSeatMonthEntry(supabase, day);
  const seatFacts = computeSeatFacts(day, entry, members, seatPrice);
  const written = await replaceSeatMonth(supabase, day, seatFacts);
```

(`replaceSeatMonth` subsumes the old snapshot delete — upsert-before-prune instead of delete-then-insert, an improvement on gotcha #4. `rows.length` is already guarded non-empty above, so `seatFacts` is never empty here.)

`attributed` below must keep counting only member facts, not the unassigned fact — change:

```ts
  const attributed = seatFacts.filter((f) => f.employeeId).length;
```
(unchanged line — the unassigned fact has `employeeId: null`, so it is not counted; verify, don't edit.)

If `upsertSpendFacts` is now unused in actions.ts, remove it from the persist import; keep `ResolvedFact` if still referenced elsewhere in the file (it is — the credits commit uses it).

- [ ] **Step 2: Verify**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all pass (`chatgpt-clipboard.test.ts` unaffected — parser untouched).

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/imports/actions.ts
git commit -m "feat: paste commit respects the month's manual seat entry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Imports-page card

**Files:**
- Create: `src/components/seat-month-entries.tsx`
- Modify: `src/app/(dashboard)/imports/page.tsx`

**Interfaces:**
- Consumes: `saveSeatMonthEntry`, `deleteSeatMonthEntry` (Task 2).
- Produces: `<SeatMonthEntries entries={SeatMonthEntryRow[]} />` with `export interface SeatMonthEntryRow { month: string /* YYYY-MM */; seats: number; priceUsd: number }`.

- [ ] **Step 1: Write the component**

```tsx
// src/components/seat-month-entries.tsx
"use client";

import { useState, useTransition } from "react";
import { saveSeatMonthEntry, deleteSeatMonthEntry } from "@/app/(dashboard)/imports/actions";
import { formatUsd } from "@/lib/utils";

export interface SeatMonthEntryRow {
  month: string; // YYYY-MM
  seats: number;
  priceUsd: number;
}

export function SeatMonthEntries({ entries }: { entries: SeatMonthEntryRow[] }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [seats, setSeats] = useState("");
  const [price, setPrice] = useState("25");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Selecting a month with a saved entry prefills its values for editing.
  const onMonth = (m: string) => {
    setMonth(m);
    const existing = entries.find((e) => e.month === m);
    setSeats(existing ? String(existing.seats) : "");
    setPrice(existing ? String(existing.priceUsd) : "25");
  };

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      setSaved(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  const onSave = () =>
    run(async () => {
      const { written } = await saveSeatMonthEntry(month, Number(seats), Number(price) || 0);
      setSaved(`Saved ${month}: ${seats} seats × ${formatUsd(Number(price) || 0)} — ${written} facts written.`);
    });

  const onDelete = (m: string) =>
    run(async () => {
      const { written } = await deleteSeatMonthEntry(m);
      setSaved(`Removed ${m} — reverted to pasted members × default price (${written} facts).`);
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          Month
          <input type="month" value={month} onChange={(e) => onMonth(e.target.value)} suppressHydrationWarning className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <label className="flex items-center gap-2 text-muted">
          Seats
          <input type="number" min="0" step="1" value={seats} onChange={(e) => setSeats(e.target.value)} className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <label className="flex items-center gap-2 text-muted">
          $ / seat
          <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <button
          onClick={onSave}
          disabled={pending || !month || seats.trim() === ""}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-accent disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save month"}
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>
      )}
      {saved && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{saved}</p>
      )}

      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Month</th>
                <th className="px-3 py-2 text-right font-medium">Seats</th>
                <th className="px-3 py-2 text-right font-medium">$ / seat</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.month} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 font-medium">{e.month}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.seats}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUsd(e.priceUsd)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUsd(Math.round(e.seats * e.priceUsd * 100) / 100)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => onDelete(e.month)} disabled={pending} className="text-xs text-pink-300 hover:underline disabled:opacity-40">
                      remove
                    </button>
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

- [ ] **Step 2: Wire the page**

In `src/app/(dashboard)/imports/page.tsx`:

1. `import { SeatMonthEntries, type SeatMonthEntryRow } from "@/components/seat-month-entries";`
2. Fetch entries after the existing `lastCsv` query (recent 36 months — a display list, bounded by `.limit`, newest first):

```ts
  const { data: seatMonths } = await supabase
    .from("seat_month_entries")
    .select("month, seats, price_usd")
    .eq("vendor", "chatgpt_business")
    .order("month", { ascending: false })
    .limit(36);
  const seatEntries: SeatMonthEntryRow[] = (seatMonths ?? []).map((r) => ({
    month: (r.month as string).slice(0, 7),
    seats: Number(r.seats),
    priceUsd: Number(r.price_usd),
  }));
```

3. Add the panel directly after the "ChatGPT Business — workspace analytics" panel (before the credits CSV panel):

```tsx
        <Panel>
          <h2 className="mb-1 text-sm font-medium">ChatGPT Business — monthly seats</h2>
          <p className="mb-4 text-xs text-muted">
            The authoritative seat count and per-seat price for a month (default $25 — override per month if
            needed). Pasted members share the entered total; seats beyond the pasted members show as
            &ldquo;unassigned seats&rdquo;. Removing a month reverts it to pasted members × default price.
          </p>
          <SeatMonthEntries entries={seatEntries} />
        </Panel>
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint && CI=true npm run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/seat-month-entries.tsx src/app/\(dashboard\)/imports/page.tsx
git commit -m "feat: monthly seat entry card on the Imports page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: changelog + full verification

**Files:**
- Modify: `src/lib/changelog.ts`

- [ ] **Step 1: Add to the changelog.** If a `2026-07-13` entry exists, append these items to it; otherwise prepend a new entry with `title: "Monthly seat entry for ChatGPT"`:

```ts
      "You can now enter a month's ChatGPT seat count and per-seat price by hand (default $25, override per month) — pasted members share the entered total, and any extra seats show as 'unassigned seats'.",
```

- [ ] **Step 2: Full verification**

Run: `npm run test && npm run lint && CI=true npm run build`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/changelog.ts
git commit -m "docs: changelog entry for monthly seat entry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand back**

Do NOT merge, push, or deploy. Report the branch is ready, and remind the user:
1. **Migration 0006 must be applied to the prod DB before deploying** (same process as migrations 0001–0005).
2. PR #17 (fractional-quantities fix) is still open and should merge first; if it lands, merge main into this branch and resolve the trivial changelog overlap.
