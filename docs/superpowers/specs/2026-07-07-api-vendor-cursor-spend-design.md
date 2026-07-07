# API page rename + vendor spend/filter, Cursor Usage spend — design

**Date:** 2026-07-07
**Status:** Approved

## Purpose

1. On the API Platforms page (name unchanged, per user): show metered spend
   per vendor with a vendor filter, and per-person spend.
2. Add spend to the Cursor Usage page: period tiles, overage spend by model,
   and per-person spend.

## Part 1 — API page

### Naming

- Page name, nav label, and URL all stay "API Platforms" / `/api-platforms`
  (user decision — no rename).
- Subtitle updates to reflect the new content: "Metered spend by vendor,
  key/project, and person, with model breakdown."

### Vendor tiles + filter (client-side; no query changes)

`getApiPlatformsScope` already ships every metered row with its `source`.
In `api-platforms-view.tsx`, between the period control and the entity list:

- One tile per vendor **present in the full scope** (stable across periods),
  plus an "All" tile. Each shows the vendor's metered total for the selected
  period, with the existing `VENDOR_COLORS` dot and `VENDOR_LABEL` name.
- Tiles are the filter: clicking a vendor tile filters the entity list and
  the person panel to that vendor; clicking "All" (or the active tile again)
  clears it. Active tile gets the accent border treatment.
- Selection persists as `?vendor=<source>` alongside `?period=` (same
  `history.replaceState` pattern). Unknown/absent param → All.

### Spend by person

New pure shaper next to `buildPlatformRows` in `src/lib/queries/api-platforms.ts`:

```ts
buildPersonRows(rows: PlatformFactRow[]): { name: string; total: number }[]
```

Groups by `ownerName`, `null` → `"Unattributed"`, sorted by total desc.
Rendered as a "Spend by person" panel below the vendor tiles; input rows are
already period- and vendor-filtered, so it respects both controls.

## Part 2 — Cursor Usage page

### Data: `getCursorSpendScope` (new, in `src/lib/queries/cursor-spend.ts`)

Fetches `spend_facts` where `source = 'cursor'` and `cost_type in
('seat','overage')` from the earliest fact month through the current month
(exclusive-end), paginated with `.order("day").order("id")` per gotcha #1,
joining `employees(full_name)`. Returns:

```ts
interface CursorSpendRow {
  day: string;          // YYYY-MM-DD
  costType: "seat" | "overage";
  model: string;        // "" for seat facts
  costUsd: number;
  personName: string | null; // employee full name, null if unmatched
}
interface CursorSpendScope { rows: CursorSpendRow[] }
```

### Shaper: `buildCursorSpendData` (new, in `src/lib/cursor-models/spend-shape.ts`)

Pure: `(scope: CursorSpendScope, period: Period)` →

```ts
{
  total: number;
  seat: number;
  overage: number;
  byModel: { model: string; cost: number }[];   // overage only; "" → "(no model)", sorted desc
  byPerson: { name: string; cost: number }[];   // seat + overage; null → "Unattributed", sorted desc
}
```

### UI (`teams-model-view.tsx`)

- Page fetches the spend scope alongside the top-model scope and passes it in.
- Tiles: three new ones — "Cursor spend" (total), "Seats", "Overage" — join
  the existing three in the same grid (2 rows of 3 on lg).
- New "Overage spend by model" panel and "Spend by person" panel, using the
  API page's bar idiom (label · proportional bar · USD), placed in the
  existing two-column grid below the current panels.
- Subtitle drops "(not spend)": "Cursor model adoption and spend by model,
  team, and person."
- The Enterprise analytics path (`CURSOR_ANALYTICS_ENABLED`) is gated off on
  the Teams plan and is untouched. The `EnterpriseLocked` fallback (no
  top-model rows at all) also stays as-is — spend panels only render with the
  Teams model view.

## Error handling

- Empty spend scope → tiles show $0 and the new panels show a quiet
  "No Cursor spend in {period}." line (matching existing empty states).
- Vendor param that names a vendor with no rows behaves as All.

## Testing

- Unit tests: `buildPersonRows` (grouping, unattributed, sort) and
  `buildCursorSpendData` (period slicing, seat/overage split, model and
  person grouping, empty input).
- `npm run test` + `CI=true npm run build` before each commit touching
  queries (project rule).
- Interactive verification on prod after merge (no local DB available).

## Out of scope

- URL rename to `/api`; per-key drill-down pages; Enterprise analytics view
  changes; spend on the Explore page (already exists there).
