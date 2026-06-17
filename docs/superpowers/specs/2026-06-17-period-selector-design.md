# Period Selector for /explore — Design

**Goal:** Replace the single-month dropdown in the `/explore` dashboard with a granularity selector (Month / Quarter / Year) plus a period stepper, so users can view spend by month, quarter, or year — both the current period "to date" and any prior complete period — with the scorecard, treemap, ranked list, and trend chart all following the selected period.

**Status:** Approved (2026-06-17).

---

## Background

Today the explore views (`Company`, `Team`, `Person`) are driven by a single `?month=YYYY-MM` query param surfaced through `PeriodControl` (a native `<select>` of the last N months). The month drives:

- `scorecard` — the selected month's total + a Month-over-Month delta vs the previous month.
- `treemap` and `ranked` list — computed over that month's facts.
- The `trend` chart is a **fixed** rolling 12-month view, independent of the selected month.
- Person view additionally renders a `daily` breakdown (days within the selected month).

A dropdown of months is low-value. Users want quick "to date" views (MTD/QTD/YTD) and the ability to browse prior quarters/years.

## Decisions (from brainstorming)

1. **Granularities:** Month / Quarter / Year. (No separate "1Y trailing" — Year + stepper covers it.)
2. **Current period shows to-date** (MTD/QTD/YTD); stepping back shows complete prior periods.
3. **Trend follows the selected period** (not a fixed 12-month view), with **adaptive bucketing**: Month → daily, Quarter → weekly, Year → monthly.
4. **No comparison delta** — the scorecard shows the period total only (drop the MoM indicator).

---

## Period model

A period is fully described by a granularity + an anchor, encoded in a single URL param `?period=`, with the format inferred:

| Format (regex) | Granularity | Example | Range `[from, toExclusive)` |
|---|---|---|---|
| `^\d{4}-\d{2}$` | month | `2026-06` | `2026-06-01` → `2026-07-01` |
| `^\d{4}-Q[1-4]$` | quarter | `2026-Q2` | `2026-04-01` → `2026-07-01` |
| `^\d{4}$` | year | `2026` | `2026-01-01` → `2027-01-01` |

- **Default** (param absent or unparseable): the current month (today's MTD).
- **`isCurrent`**: true when the anchor period contains today. There is no future spend data, so a current period's range can run to the full period end without capping — facts simply don't exist past today.
- **Label:** `"June 2026"` / `"Q2 2026"` / `"2026"`. When `isCurrent`, the control appends a "· to date" tag.

### `Period` type

```ts
export type Granularity = "month" | "quarter" | "year";
export interface Period {
  granularity: Granularity;
  anchor: string;        // canonical param form: "2026-06" | "2026-Q2" | "2026"
  from: string;          // "YYYY-MM-DD" inclusive
  toExclusive: string;   // "YYYY-MM-DD" exclusive
  label: string;         // "June 2026" | "Q2 2026" | "2026"
  isCurrent: boolean;
}
```

### Pure helpers (`src/lib/explore/period.ts`, unit-tested)

- `parsePeriod(param: string | undefined, now: Date): Period` — infer granularity from the param format, resolve the range/label/isCurrent; fall back to the current month on missing/invalid input.
- `currentPeriod(granularity, now): Period` — the to-date period of a granularity (used when a granularity button is clicked).
- `stepPeriod(period, dir: -1 | 1): Period` — previous/next period of the same granularity.
- `enumerateBuckets(period): { key: string; label: string; from: string; toExclusive: string }[]` — the trend buckets for the period:
  - **month** → one bucket per calendar day in range (label `"D"` e.g. `"14"`).
  - **quarter** → 7-day buckets from `period.from` (label `"MMM D"` of the bucket start). The final bucket is clipped to `toExclusive`.
  - **year** → 12 monthly buckets (label `"MMM"`).
- `canStepForward(period, now): boolean` — false when `period.isCurrent` (no future).
- `canStepBack(period, earliest: string): boolean` — false when stepping back would go entirely before `earliest` (the earliest month with data).

All date math uses `Date.UTC(...)` and ISO-string slicing, consistent with the existing `monthRange`/`lastNMonths` helpers. No `Date.now()`/`new Date()` without args inside pure functions — `now` is injected.

---

## Data flow

### Query layer (`src/lib/queries/explore.ts`)

- `getCompanyExplore`, `getTeamExplore`, `getPersonExplore` change their `month: string` parameter to `period: Period`.
- `fetchScope(supabase, period)` widens its fetch window so the selected period is always covered even when older than the 24-month "total to date" lookback:
  ```ts
  const from = minIso(period.from, lastNMonths(now, FETCH_MONTHS)[0] + "-01");
  const toExclusive = nextMonth(now.toISOString().slice(0, 7)); // unchanged: through current month
  ```
  `totalToDate` continues to sum **all** fetched rows (still represents all spend on record; widening only extends further back, which is correct).
- `cur` = rows where `period.from <= r.day < period.toExclusive` (replacing the `r.day.slice(0,7) === month` filter). Drives `treemap`, `ranked`, and the scorecard total.
- `assemble(rows, period, base)` builds:
  - `period` (the resolved `Period`, replacing `month`).
  - `totalToDate` — unchanged.
  - `scorecard` — `scorecardFor(cur)` (period rows; no prev period).
  - `trend` — `bothDims((d) => trendForPeriod(rows, period, d))`.
  - `treemap` — `bothDims((d) => treemapByDim(cur, d))` (unchanged shaper, period-scoped rows).
  - `ranked` — unchanged (already computed from `cur` by callers).
  - The `daily` path is **removed** (Month granularity's trend already shows daily).
- `fetchScope` returns `{ rows, earliest }` — it **drops `trendMonths`** (the trend now follows the period via `trendForPeriod`, so the rolling-12-month list is no longer needed). The `TREND_MONTHS` constant is removed; `lastNMonths`/`FETCH_MONTHS` stay (still used for the 24-month `from` bound).

### Shape layer (`src/lib/explore/shape.ts`)

- **New** `trendForPeriod(rows: ShapeFact[], period: Period, dim: Dim): TrendPoint[]`:
  - `const buckets = enumerateBuckets(period)`.
  - Build a `TrendPoint` per bucket keyed by `label`, zero-initialised.
  - For each row in `[from, toExclusive)`, find its bucket (day → exact; week → offset `floor((dayMs - fromMs) / 7d)`; month → `day.slice(0,7)`), and add `costUsd` to `point[dimKey(r, dim)]`.
  - Return points in bucket order (chronological), zero-filled.
- `scorecardFor(rows: ShapeFact[]): Scorecard` — simplified to take **already period-scoped** rows and return `{ total, seat, overage, metered }`. Drops the `month`/`prevMonth` params and `prevTotal`.
- `trendByDim` and `dailyByDim` are **removed** (superseded by `trendForPeriod`); `seriesKeys` is already unused and removed if present.

### Types (`src/lib/explore/types.ts`)

- `ExploreData`: `month: string` → `period: Period`; add `earliest: string` (the `YYYY-MM` of the earliest fact, for capping back-stepping); remove the optional `daily` field.
- `Scorecard`: remove `prevTotal`.
- Re-export `Period`, `Granularity` from `period.ts` (or import where needed).

`earliest` is the minimum `r.day` (sliced to `YYYY-MM`) across the fetched rows, or the current month when there is no data. `assemble` reads it from `fetchScope` and sets it on `ExploreData`; the page passes `data.earliest` into `PeriodControl`. It is global scope (computed before the team/person filter) — back-stepping is capped at the earliest month any data exists.

---

## Components

### `src/components/explore/period-control.tsx` (rewrite)

Client component. Props: `{ period: Period; earliest: string }`.

Layout: a segmented control + a stepper.

```
[ Month  Quarter  Year ]      ‹  Q2 2026 · to date  ›
```

- **Segmented control** — three buttons; the active granularity is highlighted (accent). Clicking a granularity navigates to `currentPeriod(granularity, now).anchor`.
- **Stepper** — `‹` / `›` buttons around the `period.label` (with a muted "· to date" suffix when `period.isCurrent`). `‹` navigates to `stepPeriod(period, -1).anchor`, disabled per `canStepBack(period, earliest)`. `›` navigates to `stepPeriod(period, +1).anchor`, disabled per `canStepForward(period, now)`.
- Navigation sets `?period=<anchor>` via `router.push` (preserving other params), same mechanism as today.
- `now` on the client: `new Date()` is fine in a client component (the no-arg restriction applies only to workflow scripts). The server-resolved `period` is authoritative for what's displayed.

Styling matches the existing toggle aesthetic (`border-border`, `bg-surface-2`, `text-accent` active) — consistent with the Vendor⇄Cost-type toggle already in `explore-view`.

### `src/components/explore/scorecards.tsx`

- Remove the `Delta` component and the `prevTotal` usage.
- Cards: **Total to date** (hero, unchanged) · **{period.label}** total · **Seat** · **Overage** · **API**. The second card's label is the period label (e.g., "Q2 2026"); no delta line.

### `src/components/explore/explore-view.tsx`

- Accept `period` + `earliest`; render `<PeriodControl period={period} earliest={earliest} />`.
- Pass `period.label` to `Scorecards`; drop the `daily` rendering branch.
- `TrendChart` already derives its series from the data and reads `label` per point — no change needed beyond receiving period-bucketed points.

### Route pages

`src/app/(dashboard)/explore/page.tsx`, `.../[team]/page.tsx`, `.../[team]/[person]/page.tsx`:

- Read `searchParams.period` (a Promise in Next 16), `parsePeriod(param, new Date())`, pass the `Period` to the query function, and thread `earliest` into the view.

---

## Error handling & edge cases

- **Invalid/missing `?period=`** → `parsePeriod` falls back to the current month. Never throws.
- **Empty period** (a past period with no data) → all shapers return zeros/empty; treemap/ranked render their existing empty states; trend shows a zero-filled axis. `canStepBack` prevents stepping entirely below `earliest`.
- **Period older than the fetch window** → `fetchScope` widens `from` to include it, so data (if any) is fetched.
- **Quarter weekly buckets** — the last bucket is clipped at `toExclusive`; a current quarter only enumerates weeks up to/over today (later weeks are zero, which is acceptable and shows "rest of quarter" as flat).

## Testing

Pure units (vitest):

- `period.test.ts` — `parsePeriod` (all three formats + fallback), `currentPeriod`, `stepPeriod` (incl. year/quarter boundaries, e.g. `2026-Q1` → `2025-Q4`), `enumerateBuckets` (day/week/month counts + labels + final-bucket clipping), `canStepForward`/`canStepBack`.
- `shape.test.ts` — extend for `trendForPeriod` (assigns rows to the right day/week/month bucket; zero-fills; respects range) and the simplified `scorecardFor` (period totals + seat/overage/metered split).

The existing 55 tests stay green; update only those referencing `scorecardFor(rows, month, prevMonth)`, `trendByDim`, `dailyByDim`, or `ExploreData.month`/`daily`.

## Addendum (2026-06-17): company-wide staff list

The Company view also gains an **"All staff"** section: a complete roster of every employee with their spend for the selected period — roster-driven ($0 included), sorted high→low, each linking to that person's drill-down. This complements the Teams ranking (company) and people-in-team ranking (team) by letting users see per-person spend across the whole company without drilling team-by-team. Implemented via a new `rankAllStaff(rows, employees)` shaper and an optional `ExploreData.allStaff` field set by `getCompanyExplore`.

## Out of scope (YAGNI)

- Custom/arbitrary date ranges.
- Comparison deltas (explicitly dropped).
- A "1Y trailing" preset (Year granularity + stepper covers prior years).
- Persisting the selected period beyond the URL.
