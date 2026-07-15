# Claude Seats: Okta Sync, Tier Overlay, and Per-Tier GBP Backfill

**Date:** 2026-07-14
**Status:** Approved design

## Problem

Claude Team seat cost currently requires a monthly roster-CSV upload. Okta's
**`access-claude`** group already knows exactly who holds a Claude seat — the
only thing it lacks is each member's **standard vs premium** tier (visible
only in the Claude admin console's members page). Separately, there is no way
to backfill historical Claude seat expenditure the way ChatGPT months can be
entered, and Claude bills are in **£**, not $.

## Decisions (agreed with Gareth)

1. **Nightly `claude_seats` sync** from the Okta `access-claude` group —
   same semantics as `chatgpt_seats` (current-UTC-month refresh; the month's
   last run is its final snapshot; email-keyed attribution).
2. **Tier overlay**: a member's tier comes from their most recent
   `seat_assignments` row; unknown members default to **standard**. The
   roster CSV becomes the occasional **tier-refresher** (upload when a tier
   changes), no longer the seat source.
3. **Backfill = per-tier monthly entries**: for any month, enter standard
   count and premium count, each at its own price.
4. **Claude entries are made in £** with an editable £→$ rate; facts stay
   USD. Original £ price and rate are stored for auditability and round-trip
   editing.
5. **The latest entry's price is THE default price** for that vendor+tier —
   everywhere. One chain, used by the entry form's prefill AND by the
   nightly syncs / rebuilds when a month has no entry:
   most recent `seat_month_entries` row (by month) → `seat_prices` →
   constants (£15 standard / £75 premium / rate 1.27 / $25 ChatGPT).
   Entering a new price in any month moves the default for every later
   month that lacks its own entry (both Claude and ChatGPT).
6. Manual entries stay **authoritative** when present (count × price is the
   tier's monthly total; members distribute; extras become unassigned).
7. The MTD-spend paste (overage) is untouched.

## Design

### Migration 0007 — `seat_month_entries` gains tier + currency audit

```sql
alter table seat_month_entries
  add column seat_type text not null default 'chatgpt',
  add column price_gbp numeric,   -- Claude: as entered; ChatGPT: null
  add column fx_rate   numeric;   -- £→$ rate used; ChatGPT: null
alter table seat_month_entries drop constraint seat_month_entries_vendor_month_key;
alter table seat_month_entries add unique (vendor, month, seat_type);
```

Existing ChatGPT rows keep working (`seat_type = 'chatgpt'`). A Claude month
holds up to two rows: `(claude_team, month, standard)` and
`(claude_team, month, premium)`. `price_usd` remains the value all fact math
uses; for Claude it is `round(price_gbp × fx_rate, 2)` computed at save time.

### Seat funnel generalization — `src/lib/ingest/seat-months.ts`

- `computeSeatFacts` gains `opts: { source: Vendor; unassignedKey: string }`
  with defaults `chatgpt_business` / `"unassigned seats"` — existing ChatGPT
  call sites unchanged.
- New `computeClaudeSeatFacts(month, tiers)` where
  `tiers: { seatType: "standard" | "premium"; entry: SeatMonthEntry | null; members: SeatMember[]; defaultPriceUsd: number }[]`
  runs the single-tier computation per tier with distinct unassigned keys —
  `"unassigned seats (standard)"` / `"unassigned seats (premium)"` — and
  concatenates. Per-tier totals are cent-exact exactly like ChatGPT.
- `getSeatMonthEntry` gains a `seatType` parameter (default `'chatgpt'`).
- `replaceSeatMonth` gains a `source` parameter; its empty-facts surgical
  delete matches `entity_key LIKE 'unassigned seats%'` (covers both tier
  keys and the ChatGPT key) — still never a window wipe (gotcha #4).
- The member-facts read in rebuilds excludes `entity_key LIKE 'unassigned seats%'`.

### Default-price chain — shared helper

`defaultSeatPrice(supabase, vendor, seatType)`: the most recent
`seat_month_entries` row for `(vendor, seatType)` by `month` desc
(`.limit(1)` — single row, no pagination needed) → its `price_usd`; else the
`seat_prices` row; else the constant (25 / 19.05 / 95.25). Used by the
`chatgpt_seats` and `claude_seats` syncs, by manual-entry rebuilds, and (with
`price_gbp`/`fx_rate` for Claude) by the entry form's prefill. The existing
`saveSeatMonthEntry`/`deleteSeatMonthEntry`/`syncChatGptSeats` call sites
switch from their `seat_prices ?? 25` lookup to this chain.

### Tier resolution — shared helper

`resolveClaudeTiers(supabase, employeeIds, month)`: for each employee, the
`seat_assignments` row (vendor `claude_team`) with the greatest
`period_start ≤ month`, else their latest row, else **standard**. Members
with no employee match are standard. Used by both the nightly sync and
manual-entry rebuilds. (Reads paginate — gotcha #1.)

### Nightly `claude_seats` sync — `src/lib/ingest/run-claude-seats.ts`

`CLAUDE_OKTA_GROUP = "access-claude"`. Same orchestrator shape as
`chatgpt_seats` (shared `fetchOktaGroupMembers`): fetch members → emails →
employees → `resolveClaudeTiers` → partition members by tier → read both
tier entries → per-tier default prices via `defaultSeatPrice` (latest entry
→ `seat_prices` → 19.05 / 95.25) →
`computeClaudeSeatFacts` → `replaceSeatMonth(claude_team, month, facts)`.
Registered source-isolated in `run-all.ts`; `sync_runs` source
`"claude_seats"`; surfaced on the Claude Team row in Data Health (same
folding as `chatgpt_seats` → ChatGPT Business).

Gotcha #4 holds: empty group + no entries → only unassigned facts removed;
member facts survive and self-heal.

### Roster CSV — tier-refresher only

`commitClaudeRoster` stops writing seat facts and stops its seat-scoped
month delete. It keeps: parsing, employee matching, `seat_assignments`
upserts, the imports log row. It then triggers a **current-month rebuild**
(members from existing facts, tiers re-resolved) so a tier change re-prices
immediately. Card copy: "Membership syncs nightly from the Okta
access-claude group — upload this roster only when someone's tier changes."

### Backfill UI — monthly seats card

- **Vendor selector** (ChatGPT Business / Claude Team). ChatGPT: single
  count + $ price row (unchanged behavior). Claude: two rows — standard and
  premium — each count + **£ price**, plus one **£→$ rate** field shared by
  both rows.
- **Prefill chain** (per vendor+tier): most recent saved entry's
  `price_gbp`/`fx_rate` (Claude) or `price_usd` (ChatGPT) → else £15 / £75 /
  1.27 / $25. Selecting a month with saved entries loads those values for
  editing.
- Save writes the entry rows (converted `price_usd` + original
  `price_gbp`/`fx_rate`) and rebuilds the month. Saving a Claude month with
  one tier count blank/0 writes only the non-zero tier's entry (a 0-count
  entry is valid too — it pins the tier to zero).
- The saved-entries table shows vendor, tier, count, price (£ for Claude
  with the $ conversion alongside), total; remove per row (removing both
  Claude tiers reverts the month to synced members × default prices).
- Server actions: `saveSeatMonthEntry`/`deleteSeatMonthEntry` gain
  vendor/seatType/currency params (all `requireAdmin()`-gated; price
  rounded to cents post-conversion, preserving the cent-exact invariant).

### Data Health

`"claude_seats"` added to the sync-run sources; folded into the
`claude_team` vendor row exactly as `chatgpt_seats` folds into
`chatgpt_business`.

### Out of scope

- Backfilling historical membership from Okta (group history isn't queryable).
- Per-member tier editing UI (the roster CSV covers tier changes).
- Currency handling anywhere else (facts and all displays remain USD).
- The seat-numbers display feature (separate, still open).

## Testing

- Per-tier compute: distinct unassigned keys; per-tier cent-exact totals;
  mixed tiers with entries on one/both tiers; zero-count entry pins a tier.
- Tier resolution: period-scoped pick, latest-fallback, default-standard.
- Default-price chain: latest entry beats `seat_prices` beats the constant,
  for both vendors; a new entry moves the default used by later no-entry
  months (sync + rebuild + prefill all agree).
- GBP conversion at save: `price_usd = round(gbp × rate, 2)`; round-trip
  edit shows the original £ values.
- Sync convergence: sync-then-entry == entry-then-sync for a month.
- Roster commit regression: writes assignments + rebuild, no direct seat
  facts, never clobbers a manually-pinned month.
- ChatGPT regression: existing entries (seat_type 'chatgpt') and the
  chatgpt_seats sync behave identically pre/post migration.
- Empty-group no-wipe at the claude_seats orchestrator level.

## Rollout

1. Apply migration 0007 to prod (Gareth, dashboard SQL editor).
2. Deploy; confirm the Okta token reads `access-claude` (manual sync →
   Data Health).
3. Backfill historical Claude months from the £ invoices.
4. Changelog entry.
