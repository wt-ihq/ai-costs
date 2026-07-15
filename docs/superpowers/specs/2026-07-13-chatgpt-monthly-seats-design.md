# Manual Monthly ChatGPT Seat Entry

**Date:** 2026-07-13
**Status:** Approved design

## Problem

ChatGPT Business seat cost currently exists only when an admin pastes the
workspace-analytics member table — one $25 seat fact per named member. There is
no way to record a month's seat spend from the invoice alone ("27 seats in
June"), and no way to override the per-seat price for a single month (price
changes, discounts).

## Decisions (agreed with Gareth)

1. **Manual entry is authoritative for the total.** A month with a manual
   entry always totals `seats × price`. The paste, when present, only
   distributes attribution across people ("manual count, paste for names").
2. **Count clash — manual count wins.** If the paste lists more members than
   the entered seat count, the authoritative total is split evenly across all
   members (each below face price). If it lists fewer, members carry face
   price and the shortfall becomes an explicit `unassigned seats` fact.
3. **Default price $25**, prefilled; editable per month.
4. Deleting a month's entry reverts that month to today's behavior
   (pasted members × default price).

## Design

### Storage — `seat_month_entries`

Migration `supabase/migrations/0006_seat_month_entries.sql`:

```sql
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

The migration must be applied to the prod DB via the existing migration
process before deploy.

### Pure computation — `computeSeatFacts`

New module `src/lib/ingest/seat-months.ts` (unit-tested):

```ts
export interface SeatMonthEntry { seats: number; priceUsd: number }
export interface SeatMember { entityKey: string; employeeId: string | null }
export const UNASSIGNED_SEATS_KEY = "unassigned seats";

/** The month's full seat-fact set. Total is always seats × price when an entry exists. */
export function computeSeatFacts(
  month: string,                 // YYYY-MM-01
  entry: SeatMonthEntry | null,
  members: SeatMember[],
  defaultPriceUsd: number,       // seat_prices chatgpt ?? 25
): ResolvedFact[]
```

| Case | Output |
|---|---|
| `entry == null` | one fact per member at `defaultPriceUsd` (today's behavior); no unassigned fact |
| entry, `members.length === 0` | one `UNASSIGNED_SEATS_KEY` fact, `seats × price` |
| entry, `M ≤ seats` | each member at `price`; one unassigned fact `(seats − M) × price` (omitted when 0) |
| entry, `M > seats` | `seats × price` split evenly across members, **cent-exact**: each row `floor(total×100/M)/100`, last row absorbs the remainder so the sum equals `seats × price` exactly |

All facts: `source: "chatgpt_business"`, `day: month`, `costType: "seat"`,
`model: ""`. Member facts keep their `entityKey`/`employeeId`; the unassigned
fact has `employeeId: null`.

### Write path — one rebuild, two triggers

`rebuildChatGptSeatMonth(supabase, month)`:
1. Read the month's `seat_month_entries` row (may be none).
2. Read the month's existing member seat facts
   (`source=chatgpt_business, cost_type=seat, day=month`, `entity_key ≠
   UNASSIGNED_SEATS_KEY`) — these are the latest paste's members.
3. `computeSeatFacts(...)` → replace via `replaceWindowFacts(supabase,
   "chatgpt_business", { startDate: month, endDate: month+1day }, facts,
   { costType: "seat" })`. Overage/credits facts are untouched (cost-type
   scope); empty output (no entry, no members) is a no-op, never a wipe
   (gotcha #4).

Triggers:
- **Manual save/delete** (`saveSeatMonthEntry` / `deleteSeatMonthEntry`
  actions): upsert/delete the `seat_month_entries` row, then rebuild.
- **Paste commit** (`commitChatGptImport`): unchanged member/identity
  handling, but seat-fact construction is replaced by
  `computeSeatFacts(month, entry, pastedMembers, defaultPrice)` +
  the same seat-scoped replace (which also subsumes the current
  `.delete().eq("cost_type","seat")` snapshot delete).

Paste-then-entry and entry-then-paste converge on identical facts.

### UI — Imports page

New card **"ChatGPT Business — monthly seats"** under the paste card:
- Form: month (`<input type="month">`), seats (number), price (number,
  prefilled from the selected month's saved entry, else `25`), Save.
- Below: a table of saved entries — month, seats, price, total
  (`seats × price`), delete button — server-rendered, newest first.
- All actions start with `await requireAdmin()`.

### Out of scope

- Other vendors (table has a `vendor` column for future use; UI is
  ChatGPT-only).
- Editing the global default ($25 stays in `seat_prices`).
- Historical backfill automation — entries are entered month by month.

## Testing

- `computeSeatFacts` unit tests: all four cases, the `(seats − M)` boundary
  (remainder omitted at 0), and the even-split rounding (e.g. 20 seats ×
  $25 over 23 members sums to exactly $500.00).
- Paste-commit regression: with no entry, output matches today's facts;
  with an entry, per-member price comes from the entry.
- `npm run test` + `CI=true npm run build` before commit.

## Rollout

1. Apply migration 0006 to prod.
2. Deploy.
3. Changelog entry in `src/lib/changelog.ts`.
