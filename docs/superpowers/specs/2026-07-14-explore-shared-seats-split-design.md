# Explore: Split "Shared seats" out of Unattributed

**Date:** 2026-07-14
**Status:** Approved design

## Problem

The Explore Teams view lumps ~$99k into one "Unattributed" row. Most of it is
**backfilled seat months** ("unassigned seats" facts) — money that by nature
cannot belong to a team because historical membership data doesn't exist.
Blending it with genuinely unmatched people/keys makes the row look like a
data-quality disaster and hides the real (small, actionable) unmatched slice.

## Decision (agreed with Gareth)

Split into two labelled pseudo-rows pinned to the BOTTOM of the teams list
(never ranked among real teams, regardless of size):

1. **"Shared seats"** — facts whose `entity_key` starts with the
   `unassigned seats` prefix (ChatGPT + both Claude tier variants). Sub-label:
   "backfilled seat months — no member data". Not clickable (no people).
2. **"Unattributed"** — everything else that lands outside a real team:
   facts matching no employee, plus facts of employees with no Okta
   department. Sub-label keeps the people count and gains a pointer:
   "N people · unmatched keys — see Data Health". Not clickable (unchanged).

Real teams rank above by total desc, exactly as today.

## Design

- `src/lib/explore/shape.ts` `rankTeams`: partition period-scoped facts
  first — `entityKey.startsWith(UNASSIGNED_PREFIX)` → the Shared seats
  bucket; remainder groups by `department ?? UNATTRIBUTED` as today. Build
  the two pseudo-rows (RankRow shape: label, total, sub, segments, no href,
  no perHead) and append after the sorted team rows: Shared seats first,
  then Unattributed. Omit either pseudo-row when its total is 0.
- `UNASSIGNED_PREFIX` is imported from `@/lib/ingest/seat-months` (pure
  constant; no runtime coupling concern).
- Segment bars (vendor / cost-type splits) render on both pseudo-rows as on
  any row.
- Headcount: "Shared seats" has no people sub; "Unattributed" keeps the
  no-department headcount ("64 people") — sub format:
  `"{n} people · unmatched keys — see Data Health"`.
- The Unattributed team drill page (`/explore/Unattributed`) is untouched
  (it isn't reachable from the teams list anyway — no href).
- No changes to trend/treemap/scorecard (their dims are vendor/cost-type).

## Out of scope

- A drill-in page for Shared seats (revisit if needed).
- Retro-attributing backfilled months (impossible — no member data).
- Data Health changes.

## Testing

- `rankTeams` unit tests: unassigned-seat facts (all three key variants) land
  in Shared seats, not Unattributed; pseudo-rows pinned last regardless of
  totals; zero-total pseudo-rows omitted; real-team ranking unchanged;
  Unattributed still catches null-employee + department-less facts.
- Changelog entry.
- `npm run test` + `CI=true npm run build`.
