# Subscription-Cost Model Rework — Design

**Goal:** Make Claude Team / ChatGPT Business seat (subscription) costs accurate and sustainable: a single source-of-truth FX rate with native-currency tier prices, invoice-driven authoritative historical backfill, and month-to-month carry-forward of Claude seats so they don't have to be re-imported every month.

**Status:** Approved (2026-06-18).

---

## Background

Seat/subscription cost is the *modeled* half of the dashboard (usage cost is *pulled* and authoritative). Today it has three problems:

1. **FX is baked and duplicated.** `seat_prices.monthly_price_usd` holds pre-converted USD, and the GBP→USD rate also lives as an editable field on the MTD-spend import. Two places, silently divergent.
2. **No history / no backfill.** A roster import writes seats for exactly the one "Month as of" month; past months are simply empty.
3. **No carry-forward.** Claude seats don't persist month-to-month (unlike Cursor seats, which the daily sync regenerates) — each month needs a manual roster import or it shows $0.

The user has previous **invoices** giving **per-seat-tier counts** per month (not per-person). Claude Team is billed in **GBP**; ChatGPT Business in **USD**.

## Decisions (from brainstorming)

- Invoices give **per-tier counts**; historical seats are recorded as **accurate monthly totals + tier split, aggregate (not per-person)** — they appear "Unattributed" in people views, which is honest.
- Input is **structured entry** (vendor + month + per-tier counts); the app applies tier prices + FX. No fragile invoice parsing.
- **Claude = GBP (FX applied), ChatGPT/Cursor = USD (no FX).**
- **Precedence per (vendor, month):** invoice (authoritative aggregate) **>** explicit roster import (per-person) **>** carry-forward (per-person estimate).

---

## Component A — Currency-aware prices + single FX (foundation)

### Schema
- `seat_prices`: add `currency text not null default 'USD'`; **rename** `monthly_price_usd` → `monthly_price` (now the price in `currency`, not necessarily USD). Migration sets:
  - `claude_team` standard = 15.00 GBP, premium = 75.00 GBP, unassigned = 0 GBP
  - `chatgpt_business` chatgpt = 25.00 USD; `cursor` teams = 40.00 USD (unchanged values, currency USD)
- `fx_rates` stays the single rate source (`GBP` → `usd_per_unit`, seeded 1.27).

### Price resolution (pure, shared)
A single helper converts a tier price to USD at write time:

```ts
// src/lib/ingest/pricing-seats.ts
export interface SeatPricing {
  // `${vendor}:${seat_type}` -> { native: number; currency: string }
  prices: Record<string, { native: number; currency: string }>;
  fx: Record<string, number>; // currency -> usd_per_unit (e.g. { GBP: 1.27 })
}
export function seatPriceUsd(vendor: string, seatType: string, p: SeatPricing): number {
  const row = p.prices[`${vendor}:${seatType}`];
  if (!row) return 0;
  const rate = row.currency === "USD" ? 1 : (p.fx[row.currency] ?? 1);
  return Math.round(row.native * rate * 100) / 100;
}
```

`loadSeatPricing(supabase)` reads `seat_prices` (vendor, seat_type, monthly_price, currency) + `fx_rates`. **Every** seat-cost site (roster preview/commit, invoice preview/commit, carry-forward) uses `seatPriceUsd` — the only place a rate is applied. `loadSeatPrices` (the old `${vendor}:${seat_type}`→USD map) is replaced by `loadSeatPricing` + `seatPriceUsd`.

### UI
The roster import card shows the same single `GBP→USD` rate field as MTD spend (read from `fx_rates`), so it's transparent that £ tiers are converted. Editing it updates `fx_rates` (admin), and re-committing re-prices.

---

## Component B — Invoice backfill (authoritative history)

### Schema
New table — each row **freezes** the resolved cost at commit time, so committed invoices are immutable historical records:
```sql
create table seat_invoices (
  vendor             vendor not null,
  month              text not null,            -- 'YYYY-MM'
  seat_type          text not null,
  quantity           integer not null,
  unit_price_native  numeric(10,2) not null,   -- tier price at commit (audit)
  currency           text not null,            -- 'GBP' | 'USD' (audit)
  fx_rate            numeric(12,6) not null,    -- rate applied at commit (1 for USD)
  line_usd           numeric(12,2) not null,    -- FROZEN resolved USD = quantity × unit_price_native × fx_rate
  primary key (vendor, month, seat_type)
);
```
The generated `seat` fact uses the **stored `line_usd`** — never a live recomputation. A later change to `seat_prices` or `fx_rates` **does not** alter committed invoices (they keep their frozen `line_usd`/`fx_rate`). The only way to change a committed invoice is to **re-enter it deliberately** (a correction), which re-freezes at the rate then in effect.

### Flow (Imports page → new "Invoice backfill" card)
- Select **vendor** (Claude Team / ChatGPT Business) + **month** (`YYYY-MM`), enter **per-tier quantities** (Claude: Standard / Premium / Unassigned; ChatGPT: seats). For GBP vendors (Claude) an **FX rate field** (default = current `fx_rates.GBP`) lets you set the rate that applied for that historical month; ChatGPT (USD) shows no FX field.
- **Preview** (`previewInvoice`): for each tier, `lineUsd = quantity × nativePrice × (currency==='GBP' ? enteredFx : 1)`; show per-tier line + month total. (`nativePrice` from `seat_prices`.)
- **Commit** (`commitInvoice`):
  1. Upsert the `seat_invoices` rows for (vendor, month), storing `quantity, unit_price_native, currency, fx_rate, line_usd` — **freezing** the resolved cost.
  2. **Snapshot-replace** that vendor's seat facts for the month: `delete spend_facts where source=vendor and cost_type='seat' and day=month-01` (clears any prior invoice *and* any roster/carry-forward per-person facts → invoice owns the month), then insert **one aggregate fact per tier** with `quantity > 0`:
     - `{ source: vendor, day: month-01, cost_type: 'seat', entity_key: seat_type, cost_usd: line_usd, employee_id: null, model: '' }`
  3. Record an `imports` row (`kind: 'invoice'`).
- **Re-commit safety:** committed invoices are frozen — global FX/price changes never re-price them; only an explicit re-entry (with possibly a new rate/quantity) changes a month's invoice.

### Attribution / views
Aggregate facts have `employee_id = null` → correct in company scorecards/trend/treemap (by vendor + tier), and shown as **Unattributed** in team/people/All-staff views. Re-pricing after an FX change = re-commit (quantities persist in `seat_invoices`).

---

## Component C — Carry-forward Claude seats (ongoing)

The daily cron regenerates the **current month's** Claude seats from the **latest roster snapshot**, so seats persist without re-importing.

- New `syncClaudeSeatsCarryForward(supabase, month)` (added to `runAllSyncs`):
  1. If a `seat_invoices` row exists for `(claude_team, month)` → **skip** (invoice owns the month).
  2. Find the latest roster snapshot: `seat_assignments` rows for `claude_team` with the max `period_start`. If none → skip (no roster yet).
  3. Resolve each assignment's email via `employees` (employee_id → email), price via `seatPriceUsd('claude_team', seat_type)`.
  4. Snapshot-replace: delete `claude_team` seat facts for `month-01`, insert **per-person** facts (`entity_key = email`, `employee_id` set, `cost_usd` per tier).
- Runs in the daily `monthToDate` cron → current month only; never overwrites past (invoiced) months.
- A fresh roster import (`commitClaudeRoster`) still writes its own "Month as of" month per-person and updates `seat_assignments`; carry-forward then propagates that snapshot to subsequent months automatically.
- Carry-forward **re-prices live** via `seatPriceUsd` (current `seat_prices × fx`); `seat_assignments.monthly_price_usd` is treated as informational/historical, not the price source — so an FX or tier-price change is reflected on the next cron run without re-import.

**ChatGPT carry-forward is out of scope** — ChatGPT has no roster-CSV equivalent (its current importer is a per-person member-table paste); ongoing ChatGPT months use invoice backfill or the existing member-table import.

---

## Precedence (avoiding double-count)

For any `(vendor, month)`, exactly one writer owns the month's `seat` facts, enforced by snapshot-replace + the carry-forward skip:

1. **Invoice present** → authoritative aggregate (per-tier). Carry-forward and re-imports for that month are suppressed/overwritten by it.
2. **Else explicit roster import** for that month → per-person.
3. **Else carry-forward** (current month only) → per-person from latest snapshot.

Each writer `delete`s all of that vendor's `cost_type='seat'` facts for the month before inserting, so the shapes never coexist. The delete is scoped to `source = vendor`, so it never touches other vendors' seats (e.g. Cursor) or non-seat facts (overage/metered).

**ChatGPT specifics:** the existing member-table importer (`commitChatGptImport`) writes per-person `seat` facts **and** `overage` facts, and currently *upserts* rather than snapshot-replacing. To fit this precedence it must be changed to **snapshot-replace its month's `seat` facts** (delete `chatgpt_business` seats for the month, then insert) — its `overage` facts are untouched by, and don't conflict with, the invoice (which only writes `seat`). By convention invoice backfill is for **historical** months and the member-table import for the **current** month, so they target different months; the snapshot-replace makes a same-month collision safe regardless (last writer wins, no accumulation).

## Error handling & edge cases

- Empty/zero quantities → no fact for that tier (tier omitted, not $0 noise); a month with all-zero is a no-op delete.
- Unknown tier (not in `seat_prices`) → `seatPriceUsd` returns 0; preview flags it so the user notices a missing price.
- No roster yet → carry-forward is a no-op (no fabricated seats).
- FX/price change → affects only the **current month** (carry-forward re-prices it on the next cron run) and any *future* commits. **Committed invoices are immutable** — they keep their frozen `line_usd`; a global rate change never rewrites settled history. To correct a past invoice you re-enter it deliberately.

## Testing (pure units, vitest)

- `seatPriceUsd`: USD passes through; GBP × fx; unknown tier → 0; rounding.
- Invoice fact generation: counts × price → per-tier aggregate facts using the **frozen** `line_usd`; zero-qty omitted; ChatGPT (USD, no FX) vs Claude (GBP × fx); a later fx/price change leaves a committed invoice's `line_usd` unchanged.
- Carry-forward selection: picks max-`period_start` snapshot; skips when a `seat_invoices` row exists; no-op with no roster.
- Existing roster/seat tests updated for the `monthly_price`→native rename and `seatPriceUsd`.

## Out of scope (YAGNI)

- Per-person historical attribution (invoices lack people).
- Historical *usage/overage* backfill (API usage already authoritative; ChatGPT historical per-person credits aren't on tier-count invoices).
- Proration (full-month per tier; minor divergence on partial cycles).
- ChatGPT seat carry-forward.

## Build order

A (price/FX foundation) → B (invoice backfill) → C (carry-forward). Each is independently testable and shippable; A underpins B and C.
