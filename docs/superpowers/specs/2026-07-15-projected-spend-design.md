# Projected Spend

**Date:** 2026-07-15
**Status:** Approved design

## Problem

The dashboard reports what was spent, never what's coming. Mid-month MTD
totals read deceptively low, and growth (the Codex ramp went ~3K→50K
credits/month in three months) only becomes visible after the money is gone.

## Decisions (agreed with Gareth)

Build now:
1. **Month-end forecast tile** — "Projected · July: $9,400 (+13% vs June)"
   on Explore (company, team, and person views), respecting the active
   vendor filter.
2. **Dashed trend projection** — a 3-month forward extension on
   month-granularity trend charts (Year / All time views).

Deferred (phase 2): budget guardrails, prepaid-credit runway.

## Core model: fixed + variable

- **Fixed** cost types (`seat`, `subscription`) post in full on the 1st —
  the month's fixed cost is already known; it is NEVER extrapolated
  (a naive MTD × days ratio would wildly overshoot early in the month).
- **Variable** cost types (`overage`, `metered`) extrapolate from the daily
  run rate.

### Month-end forecast

`projectMonthEnd(facts, now): MonthEndProjection | null` — pure, in
`src/lib/explore/project.ts`:

```ts
export interface MonthEndProjection {
  month: string;               // YYYY-MM being projected (now's month)
  projectedUsd: number;        // fixed + variableMtd + rate × remaining days
  fixedUsd: number;            // seat + subscription posted this month
  variableMtdUsd: number;      // overage + metered posted this month
  lastMonthUsd: number | null; // previous month's actual total (all cost types)
  deltaPct: number | null;     // projected vs lastMonth, null when no base
  basis: "run-rate" | "previous-month";
}
```

- **Per-source run-rate windows** (v2, 2026-07-17): each variable source's
  window runs `[month start, min(its own last data day, now − 2 days)]`.
  Days after a source's last data day are UNKNOWN, not zero — a credits CSV
  imported through the 10th divides by 10, not by days elapsed. The global
  2-day lag guard still excludes possibly-partial live days.
- **Previous-month blending** (v2): each source's observed pace is shrunk
  toward its previous-month daily rate with prior weight τ = 10 days, so a
  hot fortnight doesn't project a hot year; the blend fades as observed
  days accumulate. No prior data → pure window rate.
- **Damped trend** (v2): one aggregate factor = median month-over-month
  ratio of variable totals across the last ≤4 complete months (consecutive
  pairs only), damped 50% toward 1, clamped to [0.8, 1.2] per month and a
  [0.5, 2.0] cumulative cap. Future months' rates are bent by it, so a
  declining vendor projects downward and a growing one upward — gently.
- **Early-month fallback** (no source has a ≥3-day window):
  `basis: "previous-month"` — sources use their previous month's daily rate.
- **Monthly-snapshot usage is a level, not a rate** (added 2026-07-15):
  Claude Team's member-usage import posts a whole month's usage as one
  overage fact on the 1st. Sources in `MONTHLY_SNAPSHOT_SOURCES` project
  like fixed — counted once, repeated for future months — because feeding
  the lump into the daily run rate inflated projections ~2-3×.
- Remaining days = days from `now − 2` (exclusive) through month end, so
  the excluded lag days are projected, not dropped.
- Returns `null` when the scope has no facts in the current or previous
  month (nothing meaningful to project).
- **Manual-import honesty**: vendors whose current month arrives via manual
  import (e.g. credits between uploads) are simply absent from both MTD and
  the rate — the projection reflects what the dashboard knows, exactly like
  the MTD figures already do. No special casing.

### Trend projection

`projectTrend(facts, now, horizonMonths = 3)` — pure:

- **Same "current pace" model as the tile** (revised 2026-07-15: an earlier
  least-squares fit over past months contradicted the tile and overshot
  whenever an early ramp dominated the fit): each future month = the current
  month's fixed level + run rate × that month's days. A quarter/year tile
  therefore equals the actual bars plus the line's months — one story.
- `projectTrendForPeriod` picks labels that MATCH the chart's buckets:
  year view fills the current year's remaining month slots ("Aug"…"Dec",
  [] for past years); all-time appends 3 months in its "Aug 26" style.
- Comparison deltas are suppressed when the data span doesn't cover the
  whole previous period (a partial base yields nonsense percentages).

## Presentation

- **Scorecards**: a "Projected · <Month>" tile (dashed border, muted label —
  visually distinct from actuals; no cost-type colour reuse) appears after
  the period tile whenever the selected period INCLUDES the current month
  (this month / quarter / year / all). Sub-line: `+13% vs June` (or
  `first month with data` when `lastMonthUsd` is null). Tooltip/title text
  names the basis when it's `previous-month` ("early-month estimate").
- **Trend chart**: month-granularity views only (Year / All). The chart
  becomes a `ComposedChart`; projected months render as a **dashed neutral
  line with hollow dots** (`#8b92a5`, no fill) so projection can never be
  misread as actuals; legend entry "Projected". Day/week granularities are
  untouched.
- Both respect the active vendor filter (they're computed from the same
  filtered fact array the shapers use).
- `buildExploreData` gains `projection: { monthEnd: MonthEndProjection | null; trend: TrendPoint[] }`,
  computed from the filtered facts with `now` passed in (testability; the
  client passes `new Date()`).

## Out of scope

- Budgets/alerts; prepaid-credit runway.
- Projections for arbitrary past periods (only the current month / forward
  months are ever projected).
- Seasonality/weekday-weighting (linear + run-rate only; revisit if
  projections prove systematically off).

## Testing

Pure TDD in `project.test.ts`:
- Fixed/variable split (seats posted on the 1st never inflate the rate).
- Run-rate math incl. the 2-day lag exclusion and remaining-day count.
- Early-month `previous-month` basis switch; null when no data.
- Delta vs last month; null base handling.
- Trend fit: known linear series projects exactly; clamped at 0; `[]`
  under 2 complete months; fixed level added.
- `buildExploreData` carries the projection; existing tests unaffected.
- Changelog; `npm run test` + `CI=true npm run build`.
