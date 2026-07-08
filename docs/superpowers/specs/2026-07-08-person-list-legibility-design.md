# Person-list legibility: day counts + top-10 truncation — design

**Date:** 2026-07-08
**Status:** Approved

## Purpose

The Cursor Usage "By person" list is sorted by days-active but doesn't show
the day count, so the order reads as random; at ~30 people the panel also
dominates the page. Make the ordering legible and contain long person lists
— consistently across the three long person panels.

## Design

### 1. Shared `ShowAllList` component

`src/components/show-all-list.tsx` (client):

```tsx
export function ShowAllList<T>({
  items,
  limit = 10,
  render,
}: {
  items: T[];
  limit?: number;
  render: (item: T) => React.ReactNode; // returns an <li>
}): JSX.Element;
```

- Renders `<ul className="space-y-1.5">` of `render(item)` for the first
  `limit` items (all, when expanded).
- When `items.length > limit`, a quiet text button below the list toggles
  local `expanded` state: "Show all {n}" / "Show fewer". Styled muted,
  `text-xs`, hover to foreground. No animation, no persistence.
- `items.length <= limit` → no button, plain list.

### 2. Cursor Usage "By person" (teams-model-view.tsx)

- Each row gains a muted day count between name and model chip:
  `<span className="text-xs text-muted" title="Days with Cursor usage in this period">{p.days}d</span>`.
  `days` already exists on `TopModelPerson` — no shaper change.
- Sort unchanged (days desc, then name) — now self-explanatory.
- List wrapped in `ShowAllList` (limit 10).

### 3. Spend-by-person panels (same page + API Platforms)

- `teams-model-view.tsx` "Spend by person" and
  `api-platforms-view.tsx` "Spend by person": wrap their `<ul>`s in
  `ShowAllList` (limit 10). Rows unchanged; ordering (spend desc) is
  already self-evident.

## Error handling

- Empty lists keep their existing empty-state markup (ShowAllList is only
  reached when items exist).

## Testing

- Existing shaper tests already pin the ordering. ShowAllList is trivial
  view state; verified via lint/typecheck/build and prod eyeball (no
  component-test framework in this repo).
- Changelog entry per CLAUDE.md convention.

## Out of scope

- Collapsing entire panels; persistence of expanded state; virtualization;
  changing any sort orders.
