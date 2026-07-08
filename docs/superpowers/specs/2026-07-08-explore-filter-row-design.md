# Explore filter bar: dedicated filter row — design

**Date:** 2026-07-08
**Status:** Approved

## Purpose

Selecting a vendor unmounts the dim toggle, shifting the chip group (and the
wrap point at narrower widths). Give the filters a stable home: nothing in the
control area may appear, disappear, or move when the filter state changes.

## Design (all in `src/components/explore/explore-view.tsx`)

- **Row 1:** `PeriodControl` alone.
- **Row 2** (`flex flex-wrap items-center justify-between gap-4`):
  `VendorChips` left, dim `Toggle` right — both always rendered.
- **Toggle** gains `disabled?: boolean`:
  - ExploreView passes `dim={effectiveDim}` and `disabled={vendor !== "all"}`.
  - When disabled: both buttons get the native `disabled` attribute, the
    container gets `opacity-60` and
    `title="Charts split by cost type while a vendor filter is active"`;
    "By cost type" shows as active (that's `effectiveDim`).
  - When enabled, behavior is unchanged (`effectiveDim === dim`).
- `VendorChips` markup unchanged; no shaper, page, or helper changes.

## Testing

- View-only layout change: lint/typecheck/build; existing 131 tests must stay
  green; prod eyeball (select/deselect a vendor — nothing moves).
- No changelog entry: this is a same-day fix to the vendor-filter feature,
  which already has one.

## Out of scope

- Any change to chips content, filter semantics, URLs, or other pages.
