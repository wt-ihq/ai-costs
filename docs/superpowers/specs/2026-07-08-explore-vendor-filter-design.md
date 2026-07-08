# Explore vendor drill-down (filter + click-to-filter) — design

**Date:** 2026-07-08
**Status:** Approved (approach A + C)

## Purpose

Let users scope the entire Explore experience (Company → Team → Person) to a
single vendor and keep drilling, with the composition chart doubling as a
click-to-filter entry point.

## Design

### Filter state & data flow (`explore-view.tsx`)

- New state `vendor: Vendor | "all"`, initialized from a new optional
  `initialVendorParam?: string` prop via a pure helper:

  ```ts
  // src/lib/explore/vendor-filter.ts
  parseVendorParam(param: string | undefined, present: Vendor[]): Vendor | "all"
  vendorsInFacts(facts: ShapeFact[]): Vendor[]  // unique, VENDOR_LABEL-sorted
  ```

  Unknown/absent param or vendor not present → `"all"`.
- Filtering happens upstream of the existing shapers:
  `const facts = vendor === "all" ? scope.facts : scope.facts.filter(f => f.source === vendor)`
  and `buildExploreData({ ...scope, facts }, period)`. `totalToDate`,
  scorecards, trend, composition, and ranked lists all become vendor-scoped
  with no shaper changes. Client-side only; no new queries.
- URL sync: `?vendor=<source>` via the existing `syncParam` pattern;
  selecting "all" removes the param (syncParam gains a delete path).

### Chips row

- Between the period control and the dim toggle: an "All" chip plus one chip
  per vendor present in `scope.facts` (color dot from `VENDOR_COLORS`, label
  from `VENDOR_LABEL`, sorted by label). Styled like the existing dim toggle
  buttons. Clicking the active vendor chip returns to "All".

### Dim interaction

- `effectiveDim = vendor === "all" ? dim : "cost_type"` drives the trend
  chart, composition, and ranked split bars (a single-vendor "by vendor"
  chart is one flat color). The dim toggle is hidden while a vendor is
  selected; `dim` state is preserved and restored on returning to All.

### Drill-down links carry context

- `RankedList` gains an optional `linkQuery?: string` (e.g.
  `period=2026-07&dim=vendor&vendor=anthropic`), appended to `r.href` as
  `?${linkQuery}`. `ExploreView` builds it from current period anchor, dim,
  and vendor (omitting `vendor` when "all"); passes through `RankedPanel`.
  Fixes the existing gap where drill-down links dropped the period.

### C — click-to-filter on composition

- `CompositionBreakdown` gains optional `onSelect?: (key: string) => void`.
  When provided, each row renders as a `<button>` (hover ring, cursor).
- `ExploreView` passes `onSelect` only when `effectiveDim === "vendor"`
  (i.e., no vendor filter active); the handler applies the vendor filter,
  same as clicking the chip.

### Pages

- All three pages (`explore/page.tsx`, `[team]/page.tsx`,
  `[team]/[person]/page.tsx`) parse `sp.vendor` and pass
  `initialVendorParam` through. searchParams types gain `vendor?: string`.

## Error handling

- Vendor param naming a vendor with no rows in scope → treated as "all".
- Empty filtered period keeps existing empty states ("No spend in this
  period.").

## Testing

- Unit tests for `parseVendorParam` + `vendorsInFacts`
  (`src/lib/explore/vendor-filter.test.ts`).
- Existing shape/build tests unchanged. Changelog entry per convention.
- `npm run test` + `CI=true npm run build`; prod eyeball after merge.

## Out of scope

- Vendor pages/routes; multi-select vendors; filtering the search box;
  trend-legend click-to-filter.
