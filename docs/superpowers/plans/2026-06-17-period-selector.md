# Period Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/explore` month dropdown with a Month/Quarter/Year granularity selector + a `‹ ›` period stepper, where the selected period drives the scorecard, treemap, ranked list, and (adaptively bucketed) trend chart.

**Architecture:** A pure `period.ts` module models a `Period` (granularity + range + label) parsed from a single `?period=` URL param. The query layer takes a `Period` and scopes all breakdowns to its range; a new `trendForPeriod` shaper buckets the trend day/week/month by granularity. The `PeriodControl` moves out of the layout (which can't see per-page data) into `ExploreView`, where it receives the resolved `period` and `earliest` bound.

**Tech Stack:** Next.js 16 App Router (server components, `searchParams` is a Promise), TypeScript, Tailwind v4, Recharts, vitest.

## Global Constraints

- All date math uses `Date.UTC(...)` / `Date.parse(...+"T00:00:00Z")` and ISO-string slicing (no local-time constructors), consistent with `src/lib/rollup.ts`.
- Pure functions in `period.ts` take `now: Date` as an injected parameter (never call `new Date()` inside them) so they are deterministic and testable. Server components/pages may call `new Date()` and pass it in.
- Run `npm run test` AND `CI=true npm run build` before every commit; both must be green.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Spec: `docs/superpowers/specs/2026-06-17-period-selector-design.md`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/explore/period.ts` (new) | `Period` type + pure helpers: parse, currentPeriod, stepPeriod, enumerateBuckets, canStepBack/Forward | 1 |
| `src/lib/explore/period.test.ts` (new) | unit tests for the above | 1 |
| `src/lib/explore/shape.ts` | add `trendForPeriod`; later simplify `scorecardFor`, remove dead shapers | 2, 3 |
| `src/lib/explore/shape.test.ts` | tests for `trendForPeriod`; update `scorecardFor`, drop dead-shaper tests | 2, 3 |
| `src/lib/explore/types.ts` | `ExploreData.month`→`period`, add `earliest`, drop `daily`; `Scorecard` drop `prevTotal` | 3 |
| `src/lib/queries/explore.ts` | functions take `Period`; `fetchScope` widens + returns `earliest`; `assemble` uses `trendForPeriod`/`scorecardFor` | 3 |
| `src/components/explore/scorecards.tsx` | drop delta; label by period | 3 |
| `src/components/explore/explore-view.tsx` | use `period.label` in headings; drop `daily`; (Task 4) render `PeriodControl` | 3, 4 |
| `src/app/(dashboard)/explore/{page,[team]/page,[team]/[person]/page}.tsx` | parse `?period=`, pass `Period` | 3 |
| `src/components/explore/period-control.tsx` | rewrite: segmented control + stepper | 4 |
| `src/app/(dashboard)/explore/layout.tsx` | remove `PeriodControl` (moves to `ExploreView`) | 4 |

**Sequencing for green builds:** Tasks 1–2 are purely additive. Task 3 cuts the data layer + consumers over to `Period` while the *old* dropdown stays in the layout writing an ignored `?month=` (build stays green; the visible control is a temporary no-op). Task 4 replaces and relocates the control, completing the feature.

---

### Task 1: `period.ts` — pure period model

**Files:**
- Create: `src/lib/explore/period.ts`
- Test: `src/lib/explore/period.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Granularity = "month" | "quarter" | "year"`
  - `interface Period { granularity: Granularity; anchor: string; from: string; toExclusive: string; label: string; isCurrent: boolean }`
  - `interface Bucket { key: string; label: string; from: string; toExclusive: string }`
  - `parsePeriod(param: string | undefined, now: Date): Period`
  - `currentPeriod(g: Granularity, now: Date): Period`
  - `stepPeriod(p: Period, dir: -1 | 1, now: Date): Period`
  - `enumerateBuckets(p: Period): Bucket[]`
  - `canStepForward(p: Period): boolean`
  - `canStepBack(p: Period, earliest: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/explore/period.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  parsePeriod, currentPeriod, stepPeriod, enumerateBuckets,
  canStepForward, canStepBack,
} from "./period";

const NOW = new Date("2026-06-17T12:00:00Z"); // June 2026, Q2

describe("parsePeriod", () => {
  it("parses a month and marks the current month to-date", () => {
    expect(parsePeriod("2026-06", NOW)).toMatchObject({
      granularity: "month", anchor: "2026-06",
      from: "2026-06-01", toExclusive: "2026-07-01",
      label: "June 2026", isCurrent: true,
    });
  });
  it("parses a past month (not current)", () => {
    expect(parsePeriod("2026-05", NOW)).toMatchObject({ label: "May 2026", isCurrent: false, from: "2026-05-01", toExclusive: "2026-06-01" });
  });
  it("parses a quarter (current contains today)", () => {
    expect(parsePeriod("2026-Q2", NOW)).toMatchObject({
      granularity: "quarter", anchor: "2026-Q2",
      from: "2026-04-01", toExclusive: "2026-07-01", label: "Q2 2026", isCurrent: true,
    });
  });
  it("parses a year", () => {
    expect(parsePeriod("2026", NOW)).toMatchObject({
      granularity: "year", from: "2026-01-01", toExclusive: "2027-01-01", label: "2026", isCurrent: true,
    });
  });
  it("falls back to the current month on missing/garbage input", () => {
    expect(parsePeriod(undefined, NOW)).toMatchObject({ granularity: "month", anchor: "2026-06" });
    expect(parsePeriod("not-a-period", NOW)).toMatchObject({ granularity: "month", anchor: "2026-06" });
  });
});

describe("currentPeriod", () => {
  it("returns the to-date period for each granularity", () => {
    expect(currentPeriod("quarter", NOW).anchor).toBe("2026-Q2");
    expect(currentPeriod("year", NOW).anchor).toBe("2026");
  });
});

describe("stepPeriod", () => {
  it("steps months across the year boundary", () => {
    expect(stepPeriod(parsePeriod("2026-01", NOW), -1, NOW).anchor).toBe("2025-12");
  });
  it("steps quarters across the year boundary", () => {
    expect(stepPeriod(parsePeriod("2026-Q1", NOW), -1, NOW).anchor).toBe("2025-Q4");
  });
  it("steps years", () => {
    expect(stepPeriod(parsePeriod("2026", NOW), -1, NOW).anchor).toBe("2025");
  });
});

describe("enumerateBuckets", () => {
  it("month -> one daily bucket per day", () => {
    const b = enumerateBuckets(parsePeriod("2026-06", NOW));
    expect(b).toHaveLength(30);
    expect(b[0]).toMatchObject({ key: "2026-06-01", label: "1" });
    expect(b[29].key).toBe("2026-06-30");
  });
  it("quarter -> 7-day buckets clipped to the period end", () => {
    const b = enumerateBuckets(parsePeriod("2026-Q2", NOW)); // Apr1..Jun30 = 91 days
    expect(b).toHaveLength(13);
    expect(b[0]).toMatchObject({ key: "2026-04-01", label: "Apr 1" });
    expect(b[12].toExclusive).toBe("2026-07-01"); // last bucket clipped
  });
  it("year -> 12 monthly buckets", () => {
    const b = enumerateBuckets(parsePeriod("2026", NOW));
    expect(b).toHaveLength(12);
    expect(b[0]).toMatchObject({ key: "2026-01", label: "Jan" });
    expect(b[11]).toMatchObject({ key: "2026-12", label: "Dec" });
  });
});

describe("stepping bounds", () => {
  it("canStepForward is false only for the current period", () => {
    expect(canStepForward(parsePeriod("2026-06", NOW))).toBe(false);
    expect(canStepForward(parsePeriod("2026-05", NOW))).toBe(true);
  });
  it("canStepBack stops at the earliest month with data", () => {
    expect(canStepBack(parsePeriod("2025-08", NOW), "2025-08")).toBe(false);
    expect(canStepBack(parsePeriod("2025-09", NOW), "2025-08")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/explore/period.test.ts`
Expected: FAIL — `Failed to resolve import "./period"` / functions undefined.

- [ ] **Step 3: Implement `period.ts`**

Create `src/lib/explore/period.ts`:

```ts
export type Granularity = "month" | "quarter" | "year";

export interface Period {
  granularity: Granularity;
  anchor: string;       // "2026-06" | "2026-Q2" | "2026"
  from: string;         // "YYYY-MM-DD" inclusive
  toExclusive: string;  // "YYYY-MM-DD" exclusive
  label: string;        // "June 2026" | "Q2 2026" | "2026"
  isCurrent: boolean;
}

export interface Bucket {
  key: string;
  label: string;
  from: string;
  toExclusive: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
const DAY_MS = 86_400_000;

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const pad2 = (n: number) => String(n).padStart(2, "0");

function resolveMonth(y: number, m: number, now: Date): Period {
  return {
    granularity: "month",
    anchor: `${y}-${pad2(m + 1)}`,
    from: iso(y, m, 1),
    toExclusive: iso(y, m + 1, 1),
    label: `${MONTHS[m]} ${y}`,
    isCurrent: y === now.getUTCFullYear() && m === now.getUTCMonth(),
  };
}

function resolveQuarter(y: number, q: number, now: Date): Period {
  const startM = (q - 1) * 3;
  const nowQ = Math.floor(now.getUTCMonth() / 3) + 1;
  return {
    granularity: "quarter",
    anchor: `${y}-Q${q}`,
    from: iso(y, startM, 1),
    toExclusive: iso(y, startM + 3, 1),
    label: `Q${q} ${y}`,
    isCurrent: y === now.getUTCFullYear() && q === nowQ,
  };
}

function resolveYear(y: number, now: Date): Period {
  return {
    granularity: "year",
    anchor: `${y}`,
    from: iso(y, 0, 1),
    toExclusive: iso(y + 1, 0, 1),
    label: `${y}`,
    isCurrent: y === now.getUTCFullYear(),
  };
}

export function parsePeriod(param: string | undefined, now: Date): Period {
  let m: RegExpMatchArray | null;
  if (param && (m = param.match(/^(\d{4})-(\d{2})$/))) {
    const month = Number(m[2]) - 1;
    if (month >= 0 && month <= 11) return resolveMonth(Number(m[1]), month, now);
  } else if (param && (m = param.match(/^(\d{4})-Q([1-4])$/))) {
    return resolveQuarter(Number(m[1]), Number(m[2]), now);
  } else if (param && (m = param.match(/^(\d{4})$/))) {
    return resolveYear(Number(m[1]), now);
  }
  return resolveMonth(now.getUTCFullYear(), now.getUTCMonth(), now);
}

export function currentPeriod(g: Granularity, now: Date): Period {
  const y = now.getUTCFullYear();
  if (g === "month") return resolveMonth(y, now.getUTCMonth(), now);
  if (g === "quarter") return resolveQuarter(y, Math.floor(now.getUTCMonth() / 3) + 1, now);
  return resolveYear(y, now);
}

export function stepPeriod(p: Period, dir: -1 | 1, now: Date): Period {
  const y = Number(p.from.slice(0, 4));
  const m = Number(p.from.slice(5, 7)) - 1; // 0-indexed start month
  if (p.granularity === "month") {
    const d = new Date(Date.UTC(y, m + dir, 1));
    return resolveMonth(d.getUTCFullYear(), d.getUTCMonth(), now);
  }
  if (p.granularity === "quarter") {
    const d = new Date(Date.UTC(y, m + dir * 3, 1));
    return resolveQuarter(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) + 1, now);
  }
  return resolveYear(y + dir, now);
}

export function enumerateBuckets(p: Period): Bucket[] {
  const out: Bucket[] = [];
  const startMs = Date.parse(`${p.from}T00:00:00Z`);
  const endMs = Date.parse(`${p.toExclusive}T00:00:00Z`);

  if (p.granularity === "month") {
    for (let t = startMs; t < endMs; t += DAY_MS) {
      const key = new Date(t).toISOString().slice(0, 10);
      out.push({ key, label: String(new Date(t).getUTCDate()), from: key, toExclusive: new Date(t + DAY_MS).toISOString().slice(0, 10) });
    }
  } else if (p.granularity === "quarter") {
    for (let t = startMs; t < endMs; t += 7 * DAY_MS) {
      const from = new Date(t).toISOString().slice(0, 10);
      const next = Math.min(t + 7 * DAY_MS, endMs);
      const d = new Date(t);
      out.push({ key: from, label: `${SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`, from, toExclusive: new Date(next).toISOString().slice(0, 10) });
    }
  } else {
    const y = Number(p.from.slice(0, 4));
    for (let mo = 0; mo < 12; mo++) {
      out.push({ key: `${y}-${pad2(mo + 1)}`, label: SHORT[mo], from: iso(y, mo, 1), toExclusive: iso(y, mo + 1, 1) });
    }
  }
  return out;
}

export function canStepForward(p: Period): boolean {
  return !p.isCurrent; // the current period is the latest; no future data
}

export function canStepBack(p: Period, earliest: string): boolean {
  return p.from.slice(0, 7) > earliest; // don't step entirely before the first data month
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/explore/period.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck and commit**

Run: `CI=true npm run build` → Expected: `✓ Compiled successfully`.

```bash
git add src/lib/explore/period.ts src/lib/explore/period.test.ts
git commit -m "explore: add pure Period model + helpers (parse/step/enumerate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `trendForPeriod` shaper (additive)

**Files:**
- Modify: `src/lib/explore/shape.ts`
- Test: `src/lib/explore/shape.test.ts`

**Interfaces:**
- Consumes: `Period`, `Bucket`, `enumerateBuckets` from `./period` (Task 1); existing `ShapeFact`, `Dim`, `TrendPoint`, internal `dimKey`.
- Produces: `trendForPeriod(rows: ShapeFact[], period: Period, dim: Dim): TrendPoint[]` — chronological, zero-filled points, one per bucket, summing `costUsd` per dim key.

- [ ] **Step 1: Write the failing tests**

First, add `trendForPeriod` to the existing top-of-file `./shape` import (do NOT add a second `import … from "./shape"` line — ESLint `no-duplicate-imports` would fail the build), and add a `parsePeriod` import:

```ts
import {
  trendByDim, dailyByDim, treemapByDim, seriesKeys,
  scorecardFor, rankTeams, rankPeople, lineItems, trendForPeriod, type ShapeFact,
} from "./shape";
import { parsePeriod } from "./period";
```

Then append the new describe block:

```ts
const NOW2 = new Date("2026-06-17T12:00:00Z");

describe("trendForPeriod", () => {
  it("month granularity buckets by day and zero-fills the month", () => {
    const t = trendForPeriod(rows, parsePeriod("2026-06", NOW2), "vendor");
    expect(t).toHaveLength(30);
    expect(t.find((p) => p.label === "1")).toMatchObject({ cursor: 40 });
    expect(t.find((p) => p.label === "9")).toMatchObject({ anthropic: 100 });
    expect(t.find((p) => p.label === "2")).toEqual({ label: "2" }); // zero-filled, no series
  });
  it("year granularity buckets by month", () => {
    const t = trendForPeriod(rows, parsePeriod("2026", NOW2), "vendor");
    expect(t).toHaveLength(12);
    expect(t.find((p) => p.label === "May")).toMatchObject({ cursor: 40 });
    expect(t.find((p) => p.label === "Jun")).toMatchObject({ cursor: 40, anthropic: 100 });
  });
  it("excludes rows outside the period range", () => {
    const t = trendForPeriod(rows, parsePeriod("2026-05", NOW2), "vendor"); // only the 2026-05-03 row
    const total = t.reduce((s, p) => s + ((p.cursor as number) ?? 0) + ((p.anthropic as number) ?? 0), 0);
    expect(total).toBe(40);
  });
});
```

(`rows` is the existing fixture at the top of `shape.test.ts`: a `2026-05-03` cursor $40, a `2026-06-01` cursor $40, and a `2026-06-09` anthropic $100 fact.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/explore/shape.test.ts -t trendForPeriod`
Expected: FAIL — `trendForPeriod is not a function`.

- [ ] **Step 3: Implement `trendForPeriod`**

In `src/lib/explore/shape.ts`, add the import and the function (place the function near `trendByDim`):

```ts
import { enumerateBuckets, type Period, type Bucket } from "./period";
```

```ts
/** Period-scoped trend, adaptively bucketed (month→day, quarter→week, year→month). */
export function trendForPeriod(rows: ShapeFact[], period: Period, dim: Dim): TrendPoint[] {
  const buckets = enumerateBuckets(period);
  const points = new Map<string, TrendPoint>(buckets.map((b) => [b.key, { label: b.label }]));
  for (const r of rows) {
    if (r.day < period.from || r.day >= period.toExclusive) continue;
    const pt = points.get(bucketKey(r.day, period, buckets));
    if (!pt) continue;
    const k = dimKey(r, dim);
    pt[k] = ((pt[k] as number) ?? 0) + r.costUsd;
  }
  return buckets.map((b) => points.get(b.key)!);
}

function bucketKey(day: string, period: Period, buckets: Bucket[]): string {
  if (period.granularity === "month") return day;          // bucket key === the day
  if (period.granularity === "year") return day.slice(0, 7); // "YYYY-MM"
  const DAY_MS = 86_400_000;
  const idx = Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / (7 * DAY_MS));
  return buckets[Math.min(idx, buckets.length - 1)].key; // clamp into the clipped final week
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/explore/shape.test.ts -t trendForPeriod`
Expected: PASS.

- [ ] **Step 5: Full suite + build + commit**

Run: `npm run test` → Expected: all pass (existing 55 + new). Run: `CI=true npm run build` → Expected: `✓ Compiled successfully`.

```bash
git add src/lib/explore/shape.ts src/lib/explore/shape.test.ts
git commit -m "explore: add trendForPeriod adaptive trend shaper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Data cutover — types, query, scorecard, view, pages

Cut the data layer and its consumers over to `Period`. The old dropdown stays in the layout writing an ignored `?month=` (visible no-op) until Task 4, so the build/tests stay green throughout.

**Files:**
- Modify: `src/lib/explore/types.ts`
- Modify: `src/lib/explore/shape.ts` + `src/lib/explore/shape.test.ts`
- Modify: `src/lib/queries/explore.ts`
- Modify: `src/components/explore/scorecards.tsx`
- Modify: `src/components/explore/explore-view.tsx`
- Modify: `src/app/(dashboard)/explore/page.tsx`, `.../[team]/page.tsx`, `.../[team]/[person]/page.tsx`

**Interfaces:**
- Consumes: `Period` (Task 1), `trendForPeriod` (Task 2), existing `treemapByDim`, `rankTeams`, `rankPeople`, `lineItems`, `UNATTRIBUTED`.
- Produces:
  - `scorecardFor(rows: ShapeFact[]): Scorecard` (period-scoped rows; returns `{ total, seat, overage, metered }`).
  - `ExploreData` with `period: Period`, `earliest: string`, no `daily`.
  - `getCompanyExplore(supabase, period: Period)`, `getTeamExplore(supabase, team, period)`, `getPersonExplore(supabase, team, employeeId, period)`.

- [ ] **Step 1: Update `types.ts`**

In `src/lib/explore/types.ts`: import the period types, change `Scorecard` and `ExploreData`:

```ts
import type { Vendor, CostType } from "@/lib/types";
import type { Period, Granularity } from "./period";

export type Dim = "vendor" | "cost_type";
// ... TrendPoint, TreemapNode, RankRow unchanged ...

export interface Scorecard {
  total: number;
  seat: number;
  overage: number;
  metered: number;
}

export interface ExploreData {
  title: string;
  period: Period;
  earliest: string;
  totalToDate: number;
  scorecard: Scorecard;
  trend: Record<Dim, TrendPoint[]>;
  treemap: Record<Dim, TreemapNode[]>;
  ranked: { kind: "team" | "person" | "lineitem"; rows: RankRow[] };
}

export type { Vendor, CostType, Period, Granularity };
```

- [ ] **Step 2: Simplify `scorecardFor` and remove dead shapers in `shape.ts`**

Replace `scorecardFor` and delete `trendByDim`, `dailyByDim`, `seriesKeys`:

```ts
export function scorecardFor(rows: ShapeFact[]): Scorecard {
  const split = { seat: 0, overage: 0, metered: 0 } as Record<CostType, number>;
  for (const r of rows) split[r.costType] += r.costUsd;
  return { total: sum(rows), ...split };
}
```

Delete the `trendByDim`, `dailyByDim`, and `seriesKeys` function definitions entirely. Then delete the now-unused private helpers `inMonth` and `monthOf` (they were only used by those functions and the old `scorecardFor`; leaving them trips `@typescript-eslint/no-unused-vars` and fails the build). **Keep** `dimKey`, `labelFor`, `colorFor`, `teamSlug`, `sum`, and `totalsBy` — they are still used by `trendForPeriod`, `treemapByDim`, the rank helpers, and the new `scorecardFor`.

- [ ] **Step 3: Update `shape.test.ts`**

Remove the `import` of `trendByDim, dailyByDim, seriesKeys` and their three `describe` blocks (`trendByDim`, `dailyByDim`, `seriesKeys`). Replace the `scorecardFor` test:

```ts
describe("scorecardFor", () => {
  it("totals the given (period-scoped) rows with a cost-type split", () => {
    const sc = scorecardFor(june); // 2026-06 rows: cursor seat 40 + anthropic metered 100
    expect(sc).toMatchObject({ total: 140, seat: 40, metered: 100, overage: 0 });
  });
});
```

Ensure the top `import { ... } from "./shape"` no longer lists the deleted functions (keep `treemapByDim`, `scorecardFor`, `rankTeams`, `rankPeople`, `lineItems`, `trendForPeriod`, `type ShapeFact`).

- [ ] **Step 4: Rewrite `queries/explore.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { lastNMonths } from "@/lib/rollup";
import { fetchFactsInRange, type EnrichedFact } from "./common";
import {
  trendForPeriod, treemapByDim, scorecardFor,
  rankTeams, rankPeople, lineItems, UNATTRIBUTED, type ShapeFact,
} from "@/lib/explore/shape";
import type { Dim, ExploreData } from "@/lib/explore/types";
import type { Period } from "@/lib/explore/period";

const FETCH_MONTHS = 24; // baseline lookback for "total to date"
const asShape = (f: EnrichedFact): ShapeFact => f as unknown as ShapeFact;
const sumAll = (rows: ShapeFact[]) => Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 100) / 100;
const inPeriod = (p: Period) => (r: ShapeFact) => r.day >= p.from && r.day < p.toExclusive;

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7) + "-01";
}

/** Fetch all facts needed: max(24-month lookback, the selected period) → current month. */
async function fetchScope(supabase: SupabaseClient, period: Period) {
  const now = new Date();
  const baseFrom = lastNMonths(now, FETCH_MONTHS)[0] + "-01";
  const from = period.from < baseFrom ? period.from : baseFrom;
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));
  const rows = (await fetchFactsInRange(supabase, from, toExclusive)).map(asShape);
  const earliest = rows.length
    ? rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day).slice(0, 7)
    : now.toISOString().slice(0, 7);
  return { rows, earliest };
}

async function headcounts(supabase: SupabaseClient): Promise<Map<string, number>> {
  const { data } = await supabase.from("employees").select("department");
  const m = new Map<string, number>();
  for (const e of data ?? []) {
    const d = (e.department as string | null) ?? UNATTRIBUTED;
    m.set(d, (m.get(d) ?? 0) + 1);
  }
  return m;
}

function bothDims<T>(fn: (dim: Dim) => T): Record<Dim, T> {
  return { vendor: fn("vendor"), cost_type: fn("cost_type") };
}

function assemble(
  rows: ShapeFact[],
  period: Period,
  base: { title: string; earliest: string; ranked: ExploreData["ranked"] },
): ExploreData {
  const cur = rows.filter(inPeriod(period));
  return {
    title: base.title,
    period,
    earliest: base.earliest,
    totalToDate: sumAll(rows),
    scorecard: scorecardFor(cur),
    trend: bothDims((d) => trendForPeriod(rows, period, d)),
    treemap: bothDims((d) => treemapByDim(cur, d)),
    ranked: base.ranked,
  };
}

export async function getCompanyExplore(supabase: SupabaseClient, period: Period): Promise<ExploreData> {
  const { rows, earliest } = await fetchScope(supabase, period);
  const cur = rows.filter(inPeriod(period));
  return assemble(rows, period, { title: "Company", earliest, ranked: { kind: "team", rows: rankTeams(cur, await headcounts(supabase)) } });
}

export async function getTeamExplore(supabase: SupabaseClient, team: string, period: Period): Promise<ExploreData> {
  const { rows: all, earliest } = await fetchScope(supabase, period);
  const rows = all.filter((r) => (r.department ?? UNATTRIBUTED) === team);
  const cur = rows.filter(inPeriod(period));
  const { data: emps } = await supabase.from("employees").select("id, full_name, department").eq("department", team);
  const employees = (emps ?? []).map((e) => ({ id: e.id as string, fullName: e.full_name as string | null }));
  return assemble(rows, period, { title: team, earliest, ranked: { kind: "person", rows: rankPeople(cur, team, employees) } });
}

export async function getPersonExplore(supabase: SupabaseClient, _team: string, employeeId: string, period: Period): Promise<ExploreData> {
  const { rows: all, earliest } = await fetchScope(supabase, period);
  const rows = all.filter((r) => r.employeeId === employeeId);
  const cur = rows.filter(inPeriod(period));
  const { data: emp } = await supabase.from("employees").select("full_name").eq("id", employeeId).single();
  return assemble(rows, period, { title: (emp?.full_name as string) ?? "Unknown", earliest, ranked: { kind: "lineitem", rows: lineItems(cur) } });
}
```

- [ ] **Step 5: Update `scorecards.tsx`**

Replace the `Delta` component and the `month` prop. New file body:

```tsx
"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Scorecard } from "@/lib/explore/types";
import { formatUsd, cn } from "@/lib/utils";

function Card({ label, value, delay, hero }: { label: string; value: string; delay: number; hero?: boolean }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay }}
      className={cn("rounded-xl border p-5", hero ? "border-accent/40 bg-accent/5" : "border-border bg-surface")}
    >
      <div className={cn("text-xs uppercase tracking-wide", hero ? "text-accent" : "text-muted")}>{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
    </motion.div>
  );
}

export function Scorecards({ totalToDate, sc, periodLabel }: { totalToDate: number; sc: Scorecard; periodLabel: string }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Card label="Total to date" value={formatUsd(totalToDate)} delay={0} hero />
      <Card label={periodLabel} value={formatUsd(sc.total)} delay={0.04} />
      <Card label="Seat" value={formatUsd(sc.seat)} delay={0.08} />
      <Card label="Overage" value={formatUsd(sc.overage)} delay={0.12} />
      <Card label="API" value={formatUsd(sc.metered)} delay={0.16} />
    </div>
  );
}
```

- [ ] **Step 6: Update `explore-view.tsx` (headings + scorecards; drop `daily`)**

Change the `Scorecards` call, the two section headings, and delete the `daily` block. The `Toggle` and the rest stay as-is. Replace lines 44–63 (the `Scorecards` call through the `daily` section) with:

```tsx
      <Scorecards totalToDate={data.totalToDate} sc={data.scorecard} periodLabel={data.period.label} />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium">Trend · {data.period.label}</h2>
          <TrendChart data={data.trend[dim]} dim={dim} />
        </section>

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium">Where it&rsquo;s going · {data.period.label}</h2>
          <CompositionBreakdown nodes={data.treemap[dim]} />
        </section>
      </div>
```

- [ ] **Step 7: Update the three route pages to parse `?period=`**

`src/app/(dashboard)/explore/page.tsx`:

```tsx
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCompanyExplore } from "@/lib/queries/explore";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import { parsePeriod } from "@/lib/explore/period";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function CompanyPage({ searchParams }: { searchParams: Promise<{ period?: string; dim?: string }> }) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period, new Date());
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const data = await getCompanyExplore(getSupabaseAdminClient(), period);
  return (
    <>
      <PageHeader title="Company" subtitle="AI spend across Intent HQ — drill into a team." />
      <ExploreView data={data} initialDim={dim} />
    </>
  );
}
```

`.../[team]/page.tsx` — same pattern: replace `month` parsing with `const period = parsePeriod(sp.period, new Date());`, change the `searchParams` type to `{ period?: string; dim?: string }`, import `parsePeriod`, and call `getTeamExplore(getSupabaseAdminClient(), teamName, period)`.

`.../[team]/[person]/page.tsx` — same: `const period = parsePeriod(sp.period, new Date());`, type `{ period?: string; dim?: string }`, import `parsePeriod`, call `getPersonExplore(getSupabaseAdminClient(), decodeURIComponent(team), person, period)`.

- [ ] **Step 8: Run tests + build**

Run: `npm run test` → Expected: all pass (period + trendForPeriod + updated scorecardFor; the deleted-shaper tests are gone).
Run: `CI=true npm run build` → Expected: `✓ Compiled successfully`. (The old `PeriodControl` in the layout still compiles — it takes `months` and writes `?month=`, now ignored.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/explore/types.ts src/lib/explore/shape.ts src/lib/explore/shape.test.ts \
  src/lib/queries/explore.ts src/components/explore/scorecards.tsx src/components/explore/explore-view.tsx \
  "src/app/(dashboard)/explore/page.tsx" "src/app/(dashboard)/explore/[team]/page.tsx" "src/app/(dashboard)/explore/[team]/[person]/page.tsx"
git commit -m "explore: drive views by Period (range) instead of single month

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `PeriodControl` rewrite + relocate into `ExploreView`

**Files:**
- Modify: `src/components/explore/period-control.tsx` (rewrite)
- Modify: `src/components/explore/explore-view.tsx` (render the control)
- Modify: `src/app/(dashboard)/explore/layout.tsx` (remove the control)

**Interfaces:**
- Consumes: `Period`, `Granularity`, `currentPeriod`, `stepPeriod`, `canStepBack`, `canStepForward` from `@/lib/explore/period`; `ExploreData.period`, `ExploreData.earliest`.
- Produces: `<PeriodControl period={Period} earliest={string} />` that navigates via `?period=`.

- [ ] **Step 1: Rewrite `period-control.tsx`**

```tsx
"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { currentPeriod, stepPeriod, canStepBack, canStepForward, type Period, type Granularity } from "@/lib/explore/period";
import { cn } from "@/lib/utils";

const GRANS: { g: Granularity; label: string }[] = [
  { g: "month", label: "Month" },
  { g: "quarter", label: "Quarter" },
  { g: "year", label: "Year" },
];

/** Granularity segmented control + period stepper; navigates with ?period=. */
export function PeriodControl({ period, earliest }: { period: Period; earliest: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const now = new Date();

  const go = (anchor: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("period", anchor);
    router.push(`${pathname}?${p.toString()}`);
  };

  const back = canStepBack(period, earliest);
  const fwd = canStepForward(period);

  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
        {GRANS.map(({ g, label }) => (
          <button
            key={g}
            onClick={() => go(currentPeriod(g, now).anchor)}
            className={cn("rounded px-2.5 py-1 transition-colors", period.granularity === g ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-1 py-0.5 text-sm">
        <button
          disabled={!back}
          aria-label="Previous period"
          onClick={() => go(stepPeriod(period, -1, now).anchor)}
          className={cn("rounded px-1.5 py-0.5 transition-colors", back ? "hover:text-accent" : "cursor-not-allowed text-muted/40")}
        >
          ‹
        </button>
        <span className="min-w-[8rem] text-center tabular-nums">
          {period.label}
          {period.isCurrent && <span className="ml-1 text-xs text-muted">· to date</span>}
        </span>
        <button
          disabled={!fwd}
          aria-label="Next period"
          onClick={() => go(stepPeriod(period, 1, now).anchor)}
          className={cn("rounded px-1.5 py-0.5 transition-colors", fwd ? "hover:text-accent" : "cursor-not-allowed text-muted/40")}
        >
          ›
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render the control in `explore-view.tsx`**

Add the import and put the control in the existing top bar (left of the `Toggle`). Replace the top-bar `div` (currently `<div className="flex items-center justify-end">…Toggle…</div>`) with:

```tsx
import { PeriodControl } from "./period-control";
```

```tsx
      <div className="flex items-center justify-between gap-4">
        <PeriodControl period={data.period} earliest={data.earliest} />
        <Toggle dim={dim} onChange={setDim} />
      </div>
```

- [ ] **Step 3: Remove `PeriodControl` from the layout**

`src/app/(dashboard)/explore/layout.tsx`:

```tsx
import { Breadcrumb } from "@/components/explore/breadcrumb";

export default function ExploreLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <Breadcrumb />
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Tests + build**

Run: `npm run test` → Expected: all pass (unchanged from Task 3; no new logic tests — `PeriodControl` is a presentational client component over already-tested helpers).
Run: `CI=true npm run build` → Expected: `✓ Compiled successfully` with no unused-import lint errors (`lastNMonths` no longer imported in the layout; `months` removed).

- [ ] **Step 5: Manual verification**

Run `npm run dev`, open `/explore`, and confirm:
- The control shows `[ Month · Quarter · Year ]` + `‹ June 2026 · to date ›`; `›` is disabled.
- Clicking **Quarter** → URL `?period=2026-Q2`, label `Q2 2026 · to date`, trend switches to ~13 weekly bars, scorecard middle card reads "Q2 2026", treemap/ranked reflect the quarter.
- Clicking **Year** → `?period=2026`, 12 monthly bars, "2026 · to date".
- Stepping `‹` to a past period drops the "· to date" tag, shows the full period, and re-enables `›`.
- Back-stepping stops (disabled `‹`) at the earliest month with data.

- [ ] **Step 6: Commit**

```bash
git add src/components/explore/period-control.tsx src/components/explore/explore-view.tsx "src/app/(dashboard)/explore/layout.tsx"
git commit -m "explore: Month/Quarter/Year period selector + stepper (replaces month dropdown)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- `npm run test` — all green.
- `CI=true npm run build` — compiles clean.
- Manual: drill Company → Team → Person with each granularity; verify the period param persists across drill-down (it's preserved by `go()` merging existing params) and the trend/treemap/ranked/scorecard all reflect the selected period.

## Notes / decisions baked in

- **No comparison delta** — `Scorecard.prevTotal` and the `Delta` component are removed.
- **`daily` removed** — Month granularity's trend already shows daily bars.
- **Quarter trend = 7-day buckets from the quarter start** (not ISO weeks); the final bucket is clipped at the period end (~13 bars).
- **`earliest` is global** (min day across all fetched rows) — back-stepping is capped at the first month any data exists, even on a person page.
- **`?dim=` is preserved** across period changes (and vice-versa) because both controls merge the existing query string.
