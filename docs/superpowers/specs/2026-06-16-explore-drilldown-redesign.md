# Explore Drill-Down Dashboard — Design

**Date:** 2026-06-16
**Status:** Approved for planning
**Supersedes:** the Overview / Departments / People pages from `2026-06-11-ai-spend-dashboard-design.md` §7 (those three are replaced by this unified flow). API Platforms, Data Health, and Imports are unchanged.

## 1. Purpose

Replace the three separate rollup pages with a single, visually engaging **drill-down** that answers "where is AI spend going?" at three levels — **Company → Team → Individual** — with consistent visuals at every level and a clear time dimension. Team = HiBob department.

## 2. Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Relationship to existing pages | **Replace** Overview, Departments, People with one Explore flow (the new home) |
| Navigation | **Hybrid**: a route per level + animated transitions (deep-linkable URLs *and* a single-canvas feel) |
| Time backbone | **Rolling multi-month** trend; Individual also gets a daily trend for the selected month |
| Level anatomy | **Unified** — every level renders the same four blocks |
| Spend breakdown | **Treemap + ranked list combined**, at every level |
| Trend/treemap dimension | **Vendor ⇄ Cost-type toggle** (one control, drives both trend stacking and treemap grouping; state persists across drill) |

## 3. Routes & architecture

```
/explore                         → Company
/explore/[team]                  → Team   (team = department slug)
/explore/[team]/[personId]       → Individual
```

- `src/app/(dashboard)/explore/layout.tsx` — shared shell: **breadcrumb** (Company / Team / Person), **period control**, **toggle** (Vendor ⇄ Cost-type), and a **Motion `AnimatePresence`** wrapper for level transitions. Toggle + period live in the URL query (`?dim=vendor|cost_type&month=YYYY-MM`) so they persist across drill and are shareable.
- `template.tsx` under `/explore` provides the enter animation (Next re-mounts templates on navigation).
- Old routes `/overview`, `/departments`, `/people` → `redirect("/explore")`.
- Sidebar nav: replace those three entries with a single **Explore** (home). API Platforms, Data Health, Imports remain.

Team slug: department name URL-encoded (e.g. `Applied%20Data%20Science`); the page resolves slug → department. Unattributed bucket is a reserved slug `unattributed`.

## 4. Unified level anatomy

Every level renders the same four blocks, scaled to its data:

1. **Scorecards** — total for the selected month + MoM delta; seat / overage / metered split. (At Company/Team also per-head = spend ÷ headcount.)
2. **Rolling multi-month trend** — stacked bars across the last up to 12 months, stacked by the toggle dimension (vendor or cost-type). Animated.
3. **"Where it's going" treemap** — rectangles sized by spend, grouped/colored by the toggle dimension. Scannable composition at a glance.
4. **Ranked breakdown list** — the level's drill target:
   - **Company →** teams (each row clickable → `/explore/[team]`), with per-head.
   - **Team →** people (clickable → `/explore/[team]/[personId]`), carrying the idle-seat flag (seat cost, zero activity).
   - **Individual →** line items `vendor · cost-type · model/key` (leaf, not clickable) — the "where spending occurs" detail.

The toggle (Vendor ⇄ Cost-type) and the treemap+list combo appear at all three levels; only the ranked-list contents differ.

### Individual extras
- A **daily trend** for the selected month (in addition to the rolling monthly trend), giving the explicit time-period view.
- Seats held (which vendors), and last-active where a vendor provides it.

## 5. Data

New `src/lib/queries/explore.ts` with three builders, querying `spend_facts` joined to `employees`, over the **last 12 months** (not current-month-only):

- `getCompanyExplore(supabase, { month })` → scorecards, monthly trend (by vendor and by cost_type), treemap data, teams ranked (dept → total, headcount, per-head).
- `getTeamExplore(supabase, team, { month })` → same shape scoped to a department; ranked list = its people (with idle-seat flag).
- `getPersonExplore(supabase, employeeId, { month })` → scorecards, monthly + daily trend, treemap, and leaf line items (vendor·cost_type·model/entity), seats held.

Pure shaping helpers (aggregation, trend bucketing, treemap nodes, ranking) live alongside and are unit-tested; the DB fetch is a thin wrapper. Reuse `rollup.ts` / existing `common.ts` patterns (`fetchMonthFacts` generalized to a month-range fetch). Reads are server-side via the service-role client, gated by the dashboard layout (unchanged auth model).

Both trend dimensions (by vendor, by cost-type) are computed server-side so the client toggle is instant (no refetch).

## 6. Visual direction

Dark, refined, data-dense — consistent with the existing system and `colors.ts` (vendor + cost-type encodings reused everywhere). Built on the current Tailwind v4 + Recharts stack, adding **Motion** (`motion`) for: level transitions (slide/fade), staggered card reveals on load, hover lift on ranked rows/treemap cells, and scorecard number count-up. Charts: Recharts stacked bar/area (trend), Treemap (composition), horizontal bars (rankings). Respect `prefers-reduced-motion`.

## 7. Components

- `explore/layout.tsx`, `explore/template.tsx` (transition), and the three `page.tsx` (server components fetching data).
- Client components: `ExploreToggle` (vendor/cost-type, URL-synced), `PeriodControl` (month), `TrendChart` (stacked, dimension-aware), `SpendTreemap`, `RankedList` (clickable rows or leaf line-items), `Scorecards` (count-up).
- `src/lib/colors.ts` reused; add a small `motion`-based primitives file if helpful.

## 8. Testing

- Unit-test the pure builders/shapers (aggregation, both stacking dimensions, treemap node construction, ranking, per-head, idle-seat flag, line-item grouping) against seeded fixtures.
- Smoke-render each level (`/explore`, `/explore/[team]`, `/explore/[team]/[person]`) on seeded data (HTTP 200, expected entities present).
- Existing tests for parsers/normalizers/sync are unaffected.

## 9. Out of scope

- New data sources or sync changes (the cron/ingest pipeline is unchanged).
- Multi-currency / budgets / alerting (already out of scope in the base spec).
- Backfilling many months of history is a one-off data task, not part of this build (the trend simply fills in as history accrues).

## 10. Risks

| Risk | Mitigation |
|---|---|
| Sparse history (≈1 month synced) makes the rolling trend look bare | Trend renders whatever months exist; a one-off backfill populates more; design degrades gracefully to few bars |
| Motion transitions feel janky on slower machines | CSS-first where possible; respect `prefers-reduced-motion`; keep transitions short (≤200ms) |
| Treemap with many tiny line items (Individual) is unreadable | Cap to top N nodes + an "other" bucket; exact figures in the adjacent ranked list |
| URL-encoded department slugs with odd characters | Resolve slug→department server-side with a lookup, not string equality on raw input |
