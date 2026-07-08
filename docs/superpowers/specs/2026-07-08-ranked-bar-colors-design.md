# Ranked-list bars: chart-true colors — design

**Date:** 2026-07-08
**Status:** Approved

## Purpose

The ranked-list rows (Teams/People/Line items on Explore) tint their full row
background with vendor/cost-type colors at `opacity-30`, which muddies them —
they don't match the trend/composition charts. Replace the tinted background
with the thin full-saturation segmented-bar idiom used everywhere else.

## Design (all in `src/components/explore/ranked-list.tsx`)

- Delete `SplitBar` (the absolute-positioned `opacity-30` background).
- `Row` becomes: text line (label + idle badge + sub on the left, amount +
  per-head on the right) with a thin bar beneath:
  - Track: `mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2`, full row
    width.
  - Fill: width `total/max` of the track; split into segments per
    `r.segments[dim]`, each colored with `dimColor(dim, key)` at **full
    saturation** (identical to chart colors), `gap-0.5` (2px) between
    segments, rounded ends.
  - `r.total > 0` but no segments → single `bg-accent/40` fill.
  - `$0` rows → empty track.
- Row hover/link behavior, motion entrance, ordering, and all props
  (including `linkQuery`) unchanged. Applies to every `RankedList` usage and
  both dims automatically.
- Changelog item appended to the 2026-07-08 entry.

## Testing

- View-only: lint/typecheck/full suite (131) /build; prod eyeball comparing
  bar colors against the trend chart in both "by vendor" and "by cost type".

## Out of scope

- Chart components, shapers, colors themselves, other pages' bar styles.
