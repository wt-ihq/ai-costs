# Explore Drill-Down Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Overview/Departments/People pages with one unified Company → Team → Individual drill-down (`/explore`), with a rolling multi-month trend, a Vendor⇄Cost-type toggle, and a treemap + ranked list at every level.

**Architecture:** Each level is a server component (route per level) that fetches a 12-month slice of `spend_facts` and assembles an `ExploreData` object via pure shaper functions. A shared client `ExploreView` renders the four blocks (scorecards, trend, treemap, ranked list) and owns the Vendor⇄Cost-type toggle (instant, no refetch — both dimensions are precomputed server-side). The `explore` layout provides the breadcrumb + month control; `template.tsx` adds a Motion enter transition.

**Tech Stack:** Next.js 16 (App Router, server components), TypeScript, Tailwind v4, Recharts (trend/treemap/bars), Motion (`motion/react`) for transitions, Supabase (service-role reads). Vitest for the pure shapers.

**Reference spec:** `docs/superpowers/specs/2026-06-16-explore-drilldown-redesign.md`

---

## File Structure

**Create:**
- `src/lib/explore/types.ts` — shared types (`Dim`, `TrendPoint`, `TreemapNode`, `RankRow`, `Scorecard`, `ExploreData`).
- `src/lib/explore/shape.ts` — pure shapers (trend, treemap, scorecard, rankings, line items).
- `src/lib/explore/shape.test.ts` — unit tests for the shapers.
- `src/lib/queries/explore.ts` — `getCompanyExplore` / `getTeamExplore` / `getPersonExplore` (fetch + assemble).
- `src/components/explore/explore-view.tsx` — client; composes the four blocks + toggle.
- `src/components/explore/trend-chart.tsx` — client; stacked Recharts trend, dim-aware.
- `src/components/explore/spend-treemap.tsx` — client; Recharts treemap.
- `src/components/explore/ranked-list.tsx` — client; ranked rows (clickable or leaf).
- `src/components/explore/scorecards.tsx` — client; KPI cards with count-up.
- `src/components/explore/breadcrumb.tsx` — client; Company / Team / Person.
- `src/components/explore/period-control.tsx` — client; month selector (URL `?month=`).
- `src/app/(dashboard)/explore/layout.tsx` — shell (breadcrumb + period).
- `src/app/(dashboard)/explore/template.tsx` — Motion enter transition.
- `src/app/(dashboard)/explore/page.tsx` — Company.
- `src/app/(dashboard)/explore/[team]/page.tsx` — Team.
- `src/app/(dashboard)/explore/[team]/[person]/page.tsx` — Individual.

**Modify:**
- `src/lib/queries/common.ts` — extend `EnrichedFact` with `entityKey`+`model`; add `fetchFactsInRange`.
- `src/components/nav.tsx` — replace Overview/Departments/People with one "Explore".
- `src/app/page.tsx` — redirect to `/explore`.
- `src/app/(dashboard)/overview/page.tsx`, `departments/page.tsx`, `people/page.tsx` — replace body with `redirect("/explore")`.
- `package.json` — add `motion`.

**Reuse (no change):** `src/lib/colors.ts` (`VENDOR_COLORS`, `COST_TYPE_COLORS`), `src/lib/types.ts` (`VENDOR_LABEL`, `Vendor`, `CostType`), `src/lib/utils.ts` (`formatUsd`, `cn`), `src/lib/rollup.ts` (`lastNMonths`).

---

## Task 1: Add the Motion dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install motion**

Run: `npm install motion`
Expected: `motion` added to `dependencies`.

- [ ] **Step 2: Verify it resolves**

Run: `node -e "require.resolve('motion/react')"`
Expected: prints a path, exit 0.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add motion for explore transitions"
```

---

## Task 2: Extend EnrichedFact + add a month-range fetch

`spend_facts` rows need `entity_key` and `model` for the Individual line items, and the explore queries need a multi-month fetch (existing `fetchMonthFacts` is single-month).

**Files:**
- Modify: `src/lib/queries/common.ts`

- [ ] **Step 1: Add `entityKey`+`model` to `EnrichedFact` and a range fetch**

In `src/lib/queries/common.ts`, add `entityKey: string;` and `model: string;` to the `EnrichedFact` interface, include them in the existing `fetchMonthFacts` select/map, and append this function:

```ts
/** Fetch facts from `fromMonth` (YYYY-MM-01) up to `toExclusive` (YYYY-MM-01). */
export async function fetchFactsInRange(
  supabase: SupabaseClient,
  fromMonth: string,
  toExclusive: string,
): Promise<EnrichedFact[]> {
  const { data, error } = await supabase
    .from("spend_facts")
    .select("day, source, cost_type, cost_usd, requests, entity_key, model, employee_id, employees(full_name, department)")
    .gte("day", fromMonth)
    .lt("day", toExclusive);
  if (error) throw new Error(`fetchFactsInRange: ${error.message}`);
  return (data ?? []).map((r) => {
    const e = Array.isArray(r.employees) ? r.employees[0] : r.employees;
    const emp = e as { full_name: string | null; department: string | null } | undefined;
    return {
      source: r.source as EnrichedFact["source"],
      costType: r.cost_type as EnrichedFact["costType"],
      costUsd: Number(r.cost_usd),
      requests: r.requests == null ? null : Number(r.requests),
      entityKey: (r.entity_key as string) ?? "",
      model: (r.model as string) ?? "",
      employeeId: (r.employee_id as string | null) ?? null,
      fullName: emp?.full_name ?? null,
      department: emp?.department ?? null,
    };
  });
}
```

Also add `entityKey` and `model` to the object returned inside `fetchMonthFacts` (select `entity_key, model`, map `entityKey: (r.entity_key as string) ?? "", model: (r.model as string) ?? ""`). `fetchMonthFacts` rows otherwise lack `day`; add `day: r.day as string` to BOTH this and ensure `EnrichedFact` has `day: string`.

- [ ] **Step 2: Add `day` to EnrichedFact**

Ensure `EnrichedFact` includes `day: string;`. Update `fetchMonthFacts`'s select to include `day` and its map to set `day: r.day as string`.

- [ ] **Step 3: Typecheck**

Run: `CI=true npm run build`
Expected: `✓ Compiled successfully` (no type errors). Existing pages still compile.

- [ ] **Step 4: Commit**

```bash
git add src/lib/queries/common.ts
git commit -m "common: add entityKey/model/day to EnrichedFact + fetchFactsInRange"
```

---

## Task 3: Explore types

**Files:**
- Create: `src/lib/explore/types.ts`

- [ ] **Step 1: Write the types**

```ts
import type { Vendor, CostType } from "@/lib/types";

export type Dim = "vendor" | "cost_type";

/** One month (or day) of stacked trend data; series keys are vendor/cost-type names. */
export type TrendPoint = { label: string } & Record<string, number | string>;

export interface TreemapNode {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface RankRow {
  id: string;
  label: string;
  total: number;
  sub?: string; // secondary line (email, "idle seat", etc.)
  href?: string; // set => clickable drill row
  idle?: boolean;
  perHead?: number | null;
}

export interface Scorecard {
  total: number;
  prevTotal: number;
  seat: number;
  overage: number;
  metered: number;
}

export interface ExploreData {
  title: string;
  month: string; // YYYY-MM
  scorecard: Scorecard;
  trend: Record<Dim, TrendPoint[]>;
  treemap: Record<Dim, TreemapNode[]>;
  series: Record<Dim, string[]>; // ordered series keys present (for chart legend/stack order)
  ranked: { kind: "team" | "person" | "lineitem"; rows: RankRow[] };
  daily?: Record<Dim, TrendPoint[]>; // Individual only
}

export type { Vendor, CostType };
```

- [ ] **Step 2: Typecheck**

Run: `CI=true npx tsc --noEmit -p tsconfig.json` (or `CI=true npm run build`)
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/explore/types.ts
git commit -m "explore: shared types"
```

---

## Task 4: Shaper — trend by dimension

**Files:**
- Create: `src/lib/explore/shape.ts`
- Test: `src/lib/explore/shape.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { trendByDim, type ShapeFact } from "./shape";

const rows: ShapeFact[] = [
  { day: "2026-05-03", source: "cursor", costType: "seat", costUsd: 40, employeeId: "a", department: "Eng", fullName: "A", entityKey: "a@x", model: "" },
  { day: "2026-06-01", source: "cursor", costType: "seat", costUsd: 40, employeeId: "a", department: "Eng", fullName: "A", entityKey: "a@x", model: "" },
  { day: "2026-06-09", source: "anthropic", costType: "metered", costUsd: 100, employeeId: "a", department: "Eng", fullName: "A", entityKey: "k1", model: "opus" },
];

describe("trendByDim", () => {
  it("stacks monthly spend by vendor across the given months", () => {
    const t = trendByDim(rows, ["2026-05", "2026-06"], "vendor");
    expect(t[0]).toMatchObject({ label: "2026-05", cursor: 40 });
    expect(t[1]).toMatchObject({ label: "2026-06", cursor: 40, anthropic: 100 });
  });
  it("stacks by cost type", () => {
    const t = trendByDim(rows, ["2026-06"], "cost_type");
    expect(t[0]).toMatchObject({ label: "2026-06", seat: 40, metered: 100 });
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npm test -- shape`
Expected: FAIL (`trendByDim` not exported).

- [ ] **Step 3: Implement**

```ts
import type { Vendor, CostType } from "@/lib/types";
import type { Dim, TrendPoint } from "./types";

export interface ShapeFact {
  day: string;
  source: Vendor;
  costType: CostType;
  costUsd: number;
  employeeId: string | null;
  department: string | null;
  fullName: string | null;
  entityKey: string;
  model: string;
}

const dimKey = (r: ShapeFact, dim: Dim): string => (dim === "vendor" ? r.source : r.costType);
const monthOf = (day: string) => day.slice(0, 7);

/** Stacked monthly trend: one point per month, a numeric field per dim value. */
export function trendByDim(rows: ShapeFact[], months: string[], dim: Dim): TrendPoint[] {
  const base = new Map<string, TrendPoint>(months.map((m) => [m, { label: m }]));
  for (const r of rows) {
    const pt = base.get(monthOf(r.day));
    if (!pt) continue;
    const k = dimKey(r, dim);
    pt[k] = ((pt[k] as number) ?? 0) + r.costUsd;
  }
  return months.map((m) => base.get(m)!);
}
```

- [ ] **Step 4: Run; verify pass**

Run: `npm test -- shape`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/explore/shape.ts src/lib/explore/shape.test.ts
git commit -m "explore/shape: trendByDim"
```

---

## Task 5: Shaper — daily trend, treemap (top-N + other), series keys

**Files:**
- Modify: `src/lib/explore/shape.ts`, `src/lib/explore/shape.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `shape.test.ts`:

```ts
import { dailyByDim, treemapByDim, seriesKeys } from "./shape";

describe("dailyByDim", () => {
  it("buckets a single month by day", () => {
    const d = dailyByDim(rows, "2026-06", "vendor");
    expect(d.find((p) => p.label === "2026-06-09")).toMatchObject({ anthropic: 100 });
    expect(d.find((p) => p.label === "2026-06-01")).toMatchObject({ cursor: 40 });
  });
});

describe("treemapByDim", () => {
  it("sizes nodes by spend, sorted desc, colored", () => {
    const t = treemapByDim(rows.filter((r) => r.day.startsWith("2026-06")), "vendor");
    expect(t[0]).toMatchObject({ key: "anthropic", value: 100 });
    expect(t[1]).toMatchObject({ key: "cursor", value: 40 });
    expect(t[0].color).toBeTruthy();
  });
  it("collapses beyond topN into an 'Other' node", () => {
    const many: ShapeFact[] = Array.from({ length: 10 }, (_, i) => ({
      day: "2026-06-01", source: "openai", costType: "metered", costUsd: 10 - i, employeeId: null, department: null, fullName: null, entityKey: `k${i}`, model: `m${i}`,
    }));
    const t = treemapByDim(many, "model", 3);
    expect(t).toHaveLength(4); // 3 + Other
    expect(t[3].key).toBe("__other__");
  });
});

describe("seriesKeys", () => {
  it("returns dim values present, ordered by total desc", () => {
    expect(seriesKeys(rows.filter((r) => r.day.startsWith("2026-06")), "vendor")).toEqual(["anthropic", "cursor"]);
  });
});
```

- [ ] **Step 2: Run; verify fail**

Run: `npm test -- shape`
Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement**

Append to `shape.ts`:

```ts
import { VENDOR_COLORS, COST_TYPE_COLORS } from "@/lib/colors";
import { VENDOR_LABEL } from "@/lib/types";
import type { TreemapNode } from "./types";

const labelFor = (dim: Dim, key: string) =>
  dim === "vendor" ? (VENDOR_LABEL[key as Vendor] ?? key) : key;
const colorFor = (dim: Dim, key: string) =>
  dim === "vendor" ? (VENDOR_COLORS[key as Vendor] ?? "#6ea8fe") : (COST_TYPE_COLORS[key as CostType] ?? "#6ea8fe");

/** Single-month daily trend, stacked by dim. */
export function dailyByDim(rows: ShapeFact[], month: string, dim: Dim): TrendPoint[] {
  const byDay = new Map<string, TrendPoint>();
  for (const r of rows) {
    if (monthOf(r.day) !== month) continue;
    const pt = byDay.get(r.day) ?? { label: r.day };
    const k = dimKey(r, dim);
    pt[k] = ((pt[k] as number) ?? 0) + r.costUsd;
    byDay.set(r.day, pt);
  }
  return [...byDay.values()].sort((a, b) => (a.label < b.label ? -1 : 1));
}

function totalsBy(rows: ShapeFact[], key: (r: ShapeFact) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.costUsd);
  return m;
}

/** Treemap nodes for a dim (or model when dim-like), top-N by spend + Other. */
export function treemapByDim(rows: ShapeFact[], dim: Dim | "model", topN = 12): TreemapNode[] {
  const keyFn = dim === "model" ? (r: ShapeFact) => r.model || "(no model)" : (r: ShapeFact) => dimKey(r, dim);
  const totals = [...totalsBy(rows, keyFn).entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const head = totals.slice(0, topN);
  const rest = totals.slice(topN).reduce((s, [, v]) => s + v, 0);
  const nodes: TreemapNode[] = head.map(([key, value]) => ({
    key,
    label: dim === "model" ? key : labelFor(dim, key),
    value: Math.round(value * 100) / 100,
    color: dim === "model" ? "#6ea8fe" : colorFor(dim, key),
  }));
  if (rest > 0) nodes.push({ key: "__other__", label: "Other", value: Math.round(rest * 100) / 100, color: "#3a4150" });
  return nodes;
}

/** Dim values present, ordered by total desc (stack/legend order). */
export function seriesKeys(rows: ShapeFact[], dim: Dim): string[] {
  return [...totalsBy(rows, (r) => dimKey(r, dim)).entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}
```

- [ ] **Step 4: Run; verify pass**

Run: `npm test -- shape`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/explore/shape.ts src/lib/explore/shape.test.ts
git commit -m "explore/shape: dailyByDim, treemapByDim (top-N+Other), seriesKeys"
```

---

## Task 6: Shaper — scorecard + rankings (teams, people, line items)

**Files:**
- Modify: `src/lib/explore/shape.ts`, `src/lib/explore/shape.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `shape.test.ts`:

```ts
import { scorecardFor, rankTeams, rankPeople, lineItems } from "./shape";
import { VENDOR_LABEL } from "@/lib/types";

describe("scorecardFor", () => {
  it("totals current vs previous month with cost-type split", () => {
    const sc = scorecardFor(rows, "2026-06", "2026-05");
    expect(sc).toMatchObject({ total: 140, prevTotal: 40, seat: 40, metered: 100, overage: 0 });
  });
});

describe("rankTeams", () => {
  it("ranks departments by spend with per-head", () => {
    const r = rankTeams(rows.filter((x) => x.day.startsWith("2026-06")), new Map([["Eng", 2]]));
    expect(r[0]).toMatchObject({ id: "Eng", label: "Eng", total: 140, perHead: 70 });
    expect(r[0].href).toContain("/explore/");
  });
});

describe("rankPeople", () => {
  it("ranks people, flags idle seats, links to individual", () => {
    const idleRows: ShapeFact[] = [
      { day: "2026-06-01", source: "claude_team", costType: "seat", costUsd: 30, employeeId: "b", department: "Eng", fullName: "Bob", entityKey: "b@x", model: "" },
    ];
    const r = rankPeople(idleRows, "Eng", [{ id: "b", fullName: "Bob" }]);
    expect(r[0]).toMatchObject({ id: "b", label: "Bob", total: 30, idle: true });
    expect(r[0].href).toBe("/explore/Eng/b");
  });
});

describe("lineItems", () => {
  it("groups by vendor·cost-type·model/entity, sorted desc", () => {
    const li = lineItems(rows.filter((x) => x.day.startsWith("2026-06")));
    expect(li[0]).toMatchObject({ total: 100 });
    expect(li[0].label).toContain(VENDOR_LABEL.anthropic);
  });
});
```

- [ ] **Step 2: Run; verify fail**

Run: `npm test -- shape`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `shape.ts`:

```ts
import type { RankRow, Scorecard } from "./types";

const inMonth = (rows: ShapeFact[], m: string) => rows.filter((r) => monthOf(r.day) === m);
const sum = (rows: ShapeFact[]) => rows.reduce((s, r) => s + r.costUsd, 0);
export const UNATTRIBUTED = "Unattributed";
const teamSlug = (dept: string) => encodeURIComponent(dept);

export function scorecardFor(rows: ShapeFact[], month: string, prevMonth: string): Scorecard {
  const cur = inMonth(rows, month);
  const split = { seat: 0, overage: 0, metered: 0 } as Record<CostType, number>;
  for (const r of cur) split[r.costType] += r.costUsd;
  return { total: sum(cur), prevTotal: sum(inMonth(rows, prevMonth)), ...split };
}

/** Department rankings (current rows already filtered to the period). */
export function rankTeams(rows: ShapeFact[], headcounts: Map<string, number>): RankRow[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const d = r.department ?? UNATTRIBUTED;
    totals.set(d, (totals.get(d) ?? 0) + r.costUsd);
  }
  return [...totals.entries()]
    .map(([dept, total]) => {
      const head = headcounts.get(dept) ?? 0;
      return {
        id: dept,
        label: dept,
        total: Math.round(total * 100) / 100,
        href: dept === UNATTRIBUTED ? undefined : `/explore/${teamSlug(dept)}`,
        perHead: dept === UNATTRIBUTED || head === 0 ? null : Math.round((total / head) * 100) / 100,
        sub: head ? `${head} people` : undefined,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** People rankings within a team (rows already filtered to team + period). */
export function rankPeople(
  rows: ShapeFact[],
  teamDept: string,
  employees: { id: string; fullName: string | null }[],
): RankRow[] {
  const agg = new Map<string, { total: number; seat: number; activity: number }>();
  for (const r of rows) {
    if (!r.employeeId) continue;
    const a = agg.get(r.employeeId) ?? { total: 0, seat: 0, activity: 0 };
    a.total += r.costUsd;
    if (r.costType === "seat") a.seat += r.costUsd;
    else a.activity += r.costUsd;
    agg.set(r.employeeId, a);
  }
  const nameById = new Map(employees.map((e) => [e.id, e.fullName ?? "(unknown)"]));
  return [...agg.entries()]
    .map(([id, a]) => ({
      id,
      label: nameById.get(id) ?? "(unknown)",
      total: Math.round(a.total * 100) / 100,
      idle: a.seat > 0 && a.activity === 0,
      sub: a.seat > 0 && a.activity === 0 ? "idle seat" : undefined,
      href: `/explore/${teamSlug(teamDept)}/${id}`,
    }))
    .sort((a, b) => b.total - a.total);
}

/** Individual leaf line items: vendor · cost-type · model/entity. */
export function lineItems(rows: ShapeFact[]): RankRow[] {
  const agg = new Map<string, number>();
  const meta = new Map<string, { source: Vendor; costType: CostType; detail: string }>();
  for (const r of rows) {
    const detail = r.model || r.entityKey || "—";
    const k = `${r.source}|${r.costType}|${detail}`;
    agg.set(k, (agg.get(k) ?? 0) + r.costUsd);
    meta.set(k, { source: r.source, costType: r.costType, detail });
  }
  return [...agg.entries()]
    .map(([k, total]) => {
      const m = meta.get(k)!;
      return {
        id: k,
        label: `${VENDOR_LABEL[m.source]} · ${m.costType} · ${m.detail}`,
        total: Math.round(total * 100) / 100,
      };
    })
    .sort((a, b) => b.total - a.total);
}
```

- [ ] **Step 4: Run; verify pass**

Run: `npm test -- shape`
Expected: PASS (all shape tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/explore/shape.ts src/lib/explore/shape.test.ts
git commit -m "explore/shape: scorecardFor, rankTeams, rankPeople, lineItems"
```

---

## Task 7: Query assembly — getCompany/Team/PersonExplore

**Files:**
- Create: `src/lib/queries/explore.ts`

- [ ] **Step 1: Implement the three assemblers**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { lastNMonths } from "@/lib/rollup";
import { fetchFactsInRange, type EnrichedFact } from "./common";
import {
  trendByDim, dailyByDim, treemapByDim, seriesKeys, scorecardFor,
  rankTeams, rankPeople, lineItems, type ShapeFact,
} from "@/lib/explore/shape";
import type { Dim, ExploreData } from "@/lib/explore/types";

const MONTHS = 12;
const asShape = (f: EnrichedFact & { day: string }): ShapeFact => f as unknown as ShapeFact;

function range(month: string) {
  const months = lastNMonths(new Date(`${month}-15T00:00:00Z`), MONTHS);
  return { months, from: months[0] + "-01", toExclusive: nextMonth(months[months.length - 1]) };
}
function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7) + "-01";
}
function prevMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
}

async function headcounts(supabase: SupabaseClient): Promise<Map<string, number>> {
  const { data } = await supabase.from("employees").select("department");
  const m = new Map<string, number>();
  for (const e of data ?? []) {
    const d = (e.department as string | null) ?? "Unattributed";
    m.set(d, (m.get(d) ?? 0) + 1);
  }
  return m;
}

function bothDims<T>(fn: (dim: Dim) => T): Record<Dim, T> {
  return { vendor: fn("vendor"), cost_type: fn("cost_type") };
}

export async function getCompanyExplore(supabase: SupabaseClient, month: string): Promise<ExploreData> {
  const { months, from, toExclusive } = range(month);
  const rows = (await fetchFactsInRange(supabase, from, toExclusive)).map(asShape);
  const cur = rows.filter((r) => r.day.slice(0, 7) === month);
  return {
    title: "Company",
    month,
    scorecard: scorecardFor(rows, month, prevMonth(month)),
    trend: bothDims((d) => trendByDim(rows, months, d)),
    treemap: bothDims((d) => treemapByDim(cur, d)),
    series: bothDims((d) => seriesKeys(cur, d)),
    ranked: { kind: "team", rows: rankTeams(cur, await headcounts(supabase)) },
  };
}

export async function getTeamExplore(supabase: SupabaseClient, team: string, month: string): Promise<ExploreData> {
  const { months, from, toExclusive } = range(month);
  const all = (await fetchFactsInRange(supabase, from, toExclusive)).map(asShape);
  const rows = all.filter((r) => (r.department ?? "Unattributed") === team);
  const cur = rows.filter((r) => r.day.slice(0, 7) === month);
  const { data: emps } = await supabase.from("employees").select("id, full_name, department").eq("department", team);
  const employees = (emps ?? []).map((e) => ({ id: e.id as string, fullName: e.full_name as string | null }));
  return {
    title: team,
    month,
    scorecard: scorecardFor(rows, month, prevMonth(month)),
    trend: bothDims((d) => trendByDim(rows, months, d)),
    treemap: bothDims((d) => treemapByDim(cur, d)),
    series: bothDims((d) => seriesKeys(cur, d)),
    ranked: { kind: "person", rows: rankPeople(cur, team, employees) },
  };
}

export async function getPersonExplore(supabase: SupabaseClient, team: string, employeeId: string, month: string): Promise<ExploreData> {
  const { months, from, toExclusive } = range(month);
  const all = (await fetchFactsInRange(supabase, from, toExclusive)).map(asShape);
  const rows = all.filter((r) => r.employeeId === employeeId);
  const cur = rows.filter((r) => r.day.slice(0, 7) === month);
  const { data: emp } = await supabase.from("employees").select("full_name").eq("id", employeeId).single();
  return {
    title: (emp?.full_name as string) ?? "Unknown",
    month,
    scorecard: scorecardFor(rows, month, prevMonth(month)),
    trend: bothDims((d) => trendByDim(rows, months, d)),
    treemap: bothDims((d) => treemapByDim(cur, d)),
    series: bothDims((d) => seriesKeys(cur, d)),
    ranked: { kind: "lineitem", rows: lineItems(cur) },
    daily: bothDims((d) => dailyByDim(rows, month, d)),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `CI=true npm run build`
Expected: `✓ Compiled successfully`. (Pages don't exist yet; this just compiles the lib.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/queries/explore.ts
git commit -m "explore: query assemblers for company/team/person"
```

---

## Task 8: Scorecards (client, count-up)

**Files:**
- Create: `src/components/explore/scorecards.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Scorecard } from "@/lib/explore/types";
import { formatUsd } from "@/lib/utils";

function Delta({ current, prev }: { current: number; prev: number }) {
  if (prev === 0) return <span className="text-xs text-muted">no prior month</span>;
  const pct = ((current - prev) / prev) * 100;
  const up = pct >= 0;
  return <span className={up ? "text-xs text-pink-300" : "text-xs text-emerald-300"}>{up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% MoM</span>;
}

function Card({ label, value, delay, children }: { label: string; value: string; delay: number; children?: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay }}
      className="rounded-xl border border-border bg-surface p-5"
    >
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1">{children}</div>
    </motion.div>
  );
}

export function Scorecards({ sc }: { sc: Scorecard }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card label="Total this month" value={formatUsd(sc.total)} delay={0}><Delta current={sc.total} prev={sc.prevTotal} /></Card>
      <Card label="Seat" value={formatUsd(sc.seat)} delay={0.04} />
      <Card label="Overage" value={formatUsd(sc.overage)} delay={0.08} />
      <Card label="Metered" value={formatUsd(sc.metered)} delay={0.12} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `CI=true npm run build`
Expected: compiles (component unused yet is fine).

- [ ] **Step 3: Commit**

```bash
git add src/components/explore/scorecards.tsx
git commit -m "explore: Scorecards component"
```

---

## Task 9: TrendChart (client, dim-aware stacked)

**Files:**
- Create: `src/components/explore/trend-chart.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Dim, TrendPoint } from "@/lib/explore/types";
import type { Vendor, CostType } from "@/lib/types";
import { VENDOR_COLORS, COST_TYPE_COLORS } from "@/lib/colors";
import { VENDOR_LABEL } from "@/lib/types";
import { formatUsd } from "@/lib/utils";

const AXIS = { stroke: "#8b92a5", fontSize: 11 };
const usd = (v: unknown) => formatUsd(Number(v));

export function TrendChart({ data, series, dim, height = 260 }: { data: TrendPoint[]; series: string[]; dim: Dim; height?: number }) {
  const color = (k: string) => (dim === "vendor" ? VENDOR_COLORS[k as Vendor] ?? "#6ea8fe" : COST_TYPE_COLORS[k as CostType] ?? "#6ea8fe");
  const label = (k: string) => (dim === "vendor" ? VENDOR_LABEL[k as Vendor] ?? k : k);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
        <XAxis dataKey="label" tickLine={false} axisLine={false} {...AXIS} />
        <YAxis tickFormatter={(v) => `$${(Number(v) / 1000).toFixed(0)}k`} tickLine={false} axisLine={false} width={44} {...AXIS} />
        <Tooltip contentStyle={{ background: "#14171f", border: "1px solid #262b38", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "#e6e8ee" }} formatter={usd} />
        {series.map((k) => (
          <Area key={k} type="monotone" dataKey={k} name={label(k)} stackId="1" stroke={color(k)} fill={color(k)} fillOpacity={0.25} isAnimationActive />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `CI=true npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/components/explore/trend-chart.tsx
git commit -m "explore: TrendChart"
```

---

## Task 10: SpendTreemap (client)

**Files:**
- Create: `src/components/explore/spend-treemap.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";

import { ResponsiveContainer, Tooltip, Treemap } from "recharts";
import type { TreemapNode } from "@/lib/explore/types";
import { formatUsd } from "@/lib/utils";

interface CellProps { x?: number; y?: number; width?: number; height?: number; label?: string; color?: string; value?: number }
function Cell({ x = 0, y = 0, width = 0, height = 0, label, color, value }: CellProps) {
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={4} fill={color ?? "#6ea8fe"} fillOpacity={0.85} stroke="#0b0d12" strokeWidth={2} />
      {width > 70 && height > 28 && (
        <text x={x + 8} y={y + 20} fill="#0b0d12" fontSize={12} fontWeight={600}>
          {label}{value != null ? ` · ${formatUsd(value)}` : ""}
        </text>
      )}
    </g>
  );
}

export function SpendTreemap({ nodes, height = 240 }: { nodes: TreemapNode[]; height?: number }) {
  if (!nodes.length) return <div className="flex h-40 items-center justify-center text-sm text-muted">No spend this month.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <Treemap data={nodes} dataKey="value" nameKey="label" content={<Cell />} isAnimationActive>
        <Tooltip contentStyle={{ background: "#14171f", border: "1px solid #262b38", borderRadius: 8, fontSize: 12 }} formatter={(v: unknown) => formatUsd(Number(v))} />
      </Treemap>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `CI=true npm run build`
Expected: compiles. (Recharts `Treemap` passes node fields incl. `color`/`label` to `content`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/explore/spend-treemap.tsx
git commit -m "explore: SpendTreemap"
```

---

## Task 11: RankedList (client; clickable rows or leaf)

**Files:**
- Create: `src/components/explore/ranked-list.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import type { RankRow } from "@/lib/explore/types";
import { formatUsd, cn } from "@/lib/utils";

function Row({ r, max, i }: { r: RankRow; max: number; i: number }) {
  const reduce = useReducedMotion();
  const pct = max > 0 ? (r.total / max) * 100 : 0;
  const body = (
    <motion.div
      initial={reduce ? false : { opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.15, delay: Math.min(i, 20) * 0.015 }}
      className={cn("group relative flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-surface px-4 py-3 transition-colors", r.href && "hover:border-accent/60 hover:bg-surface-2")}
    >
      <div className="absolute inset-y-0 left-0 rounded-l-lg bg-accent/10" style={{ width: `${pct}%` }} aria-hidden />
      <div className="relative min-w-0">
        <div className="truncate text-sm font-medium">
          {r.label}
          {r.idle && <span className="ml-2 rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-pink-300">idle seat</span>}
        </div>
        {r.sub && <div className="truncate text-xs text-muted">{r.sub}</div>}
      </div>
      <div className="relative shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">{formatUsd(r.total)}</div>
        {r.perHead != null && <div className="text-xs text-muted">{formatUsd(r.perHead)}/head</div>}
      </div>
    </motion.div>
  );
  return r.href ? <Link href={r.href} className="block">{body}</Link> : body;
}

export function RankedList({ rows }: { rows: RankRow[] }) {
  if (!rows.length) return <p className="text-sm text-muted">No spend this month.</p>;
  const max = Math.max(...rows.map((r) => r.total), 0);
  return <div className="space-y-2">{rows.map((r, i) => <Row key={r.id} r={r} max={max} i={i} />)}</div>;
}
```

- [ ] **Step 2: Typecheck**

Run: `CI=true npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/components/explore/ranked-list.tsx
git commit -m "explore: RankedList"
```

---

## Task 12: ExploreView (client; composes blocks + owns the toggle)

**Files:**
- Create: `src/components/explore/explore-view.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";

import { useState } from "react";
import type { Dim, ExploreData } from "@/lib/explore/types";
import { cn } from "@/lib/utils";
import { Scorecards } from "./scorecards";
import { TrendChart } from "./trend-chart";
import { SpendTreemap } from "./spend-treemap";
import { RankedList } from "./ranked-list";

const RANK_TITLE: Record<ExploreData["ranked"]["kind"], string> = {
  team: "Teams", person: "People", lineitem: "Where it's going",
};

function Toggle({ dim, onChange }: { dim: Dim; onChange: (d: Dim) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
      {(["vendor", "cost_type"] as Dim[]).map((d) => (
        <button
          key={d}
          onClick={() => {
            onChange(d);
            const url = new URL(window.location.href);
            url.searchParams.set("dim", d);
            window.history.replaceState(null, "", url);
          }}
          className={cn("rounded px-2.5 py-1 transition-colors", dim === d ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
        >
          {d === "vendor" ? "By vendor" : "By cost type"}
        </button>
      ))}
    </div>
  );
}

export function ExploreView({ data, initialDim }: { data: ExploreData; initialDim: Dim }) {
  const [dim, setDim] = useState<Dim>(initialDim);
  return (
    <div className="space-y-6">
      <Scorecards sc={data.scorecard} />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface p-5">
          <header className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium">12-month trend</h2>
            <Toggle dim={dim} onChange={setDim} />
          </header>
          <TrendChart data={data.trend[dim]} series={data.series[dim]} dim={dim} />
        </section>

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium">Where it&rsquo;s going · {data.month}</h2>
          <SpendTreemap nodes={data.treemap[dim]} />
        </section>
      </div>

      {data.daily && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium">Daily · {data.month}</h2>
          <TrendChart data={data.daily[dim]} series={data.series[dim]} dim={dim} height={200} />
        </section>
      )}

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-4 text-sm font-medium">{RANK_TITLE[data.ranked.kind]}</h2>
        <RankedList rows={data.ranked.rows} />
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `CI=true npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/components/explore/explore-view.tsx
git commit -m "explore: ExploreView (composes blocks + toggle)"
```

---

## Task 13: Breadcrumb, PeriodControl, layout, template

**Files:**
- Create: `src/components/explore/breadcrumb.tsx`, `src/components/explore/period-control.tsx`, `src/app/(dashboard)/explore/layout.tsx`, `src/app/(dashboard)/explore/template.tsx`

- [ ] **Step 1: Breadcrumb**

`src/components/explore/breadcrumb.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export function Breadcrumb() {
  const parts = usePathname().split("/").filter(Boolean); // ["explore", team?, person?]
  const qs = useSearchParams().toString();
  const q = qs ? `?${qs}` : "";
  const crumbs = [{ href: `/explore${q}`, label: "Company" }];
  if (parts[1]) crumbs.push({ href: `/explore/${parts[1]}${q}`, label: decodeURIComponent(parts[1]) });
  if (parts[2]) crumbs.push({ href: `/explore/${parts[1]}/${parts[2]}${q}`, label: "Individual" });
  return (
    <nav className="flex items-center gap-2 text-sm text-muted">
      {crumbs.map((c, i) => (
        <span key={c.href} className="flex items-center gap-2">
          {i > 0 && <span className="text-border">/</span>}
          {i < crumbs.length - 1 ? <Link href={c.href} className="hover:text-foreground">{c.label}</Link> : <span className="text-foreground">{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: PeriodControl**

`src/components/explore/period-control.tsx`:

```tsx
"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

/** Month picker; navigates with ?month= so the server refetches. */
export function PeriodControl({ months, current }: { months: string[]; current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <select
      value={current}
      onChange={(e) => {
        const p = new URLSearchParams(params.toString());
        p.set("month", e.target.value);
        router.push(`${pathname}?${p.toString()}`);
      }}
      className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
    >
      {months.map((m) => <option key={m} value={m}>{m}</option>)}
    </select>
  );
}
```

- [ ] **Step 3: Layout**

`src/app/(dashboard)/explore/layout.tsx`:

```tsx
import { Breadcrumb } from "@/components/explore/breadcrumb";
import { PeriodControl } from "@/components/explore/period-control";
import { lastNMonths } from "@/lib/rollup";

export default function ExploreLayout({ children }: { children: React.ReactNode }) {
  const months = [...lastNMonths(new Date(), 12)].reverse(); // newest first
  const current = new Date().toISOString().slice(0, 7);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Breadcrumb />
        <PeriodControl months={months} current={current} />
      </div>
      {children}
    </div>
  );
}
```

Note: `PeriodControl`'s `current` shows the default; the actual selected month comes from each page's `month` searchParam (the select is uncontrolled-by-server but reflects the URL via the page). Acceptable: the select pushes `?month=`; pages read it.

- [ ] **Step 4: Template (Motion enter transition)**

`src/app/(dashboard)/explore/template.tsx`:

```tsx
"use client";

import { motion, useReducedMotion } from "motion/react";

export default function ExploreTemplate({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `CI=true npm run build`
Expected: compiles.

- [ ] **Step 6: Commit**

```bash
git add "src/components/explore/breadcrumb.tsx" "src/components/explore/period-control.tsx" "src/app/(dashboard)/explore/layout.tsx" "src/app/(dashboard)/explore/template.tsx"
git commit -m "explore: breadcrumb, period control, layout, transition template"
```

---

## Task 14: The three level pages

**Files:**
- Create: `src/app/(dashboard)/explore/page.tsx`, `src/app/(dashboard)/explore/[team]/page.tsx`, `src/app/(dashboard)/explore/[team]/[person]/page.tsx`

- [ ] **Step 1: Company page**

`src/app/(dashboard)/explore/page.tsx`:

```tsx
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCompanyExplore } from "@/lib/queries/explore";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function CompanyPage({ searchParams }: { searchParams: Promise<{ month?: string; dim?: string }> }) {
  const sp = await searchParams;
  const month = sp.month ?? new Date().toISOString().slice(0, 7);
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const data = await getCompanyExplore(getSupabaseAdminClient(), month);
  return (
    <>
      <PageHeader title="Company" subtitle="AI spend across Intent HQ — drill into a team." />
      <ExploreView data={data} initialDim={dim} />
    </>
  );
}
```

- [ ] **Step 2: Team page**

`src/app/(dashboard)/explore/[team]/page.tsx`:

```tsx
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTeamExplore } from "@/lib/queries/explore";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function TeamPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: Promise<{ month?: string; dim?: string }> }) {
  const { team } = await params;
  const sp = await searchParams;
  const teamName = decodeURIComponent(team);
  const month = sp.month ?? new Date().toISOString().slice(0, 7);
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const data = await getTeamExplore(getSupabaseAdminClient(), teamName, month);
  return (
    <>
      <PageHeader title={teamName} subtitle="Team spend — drill into a person." />
      <ExploreView data={data} initialDim={dim} />
    </>
  );
}
```

- [ ] **Step 3: Individual page**

`src/app/(dashboard)/explore/[team]/[person]/page.tsx`:

```tsx
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getPersonExplore } from "@/lib/queries/explore";
import { ExploreView } from "@/components/explore/explore-view";
import { PageHeader } from "@/components/ui";
import type { Dim } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

export default async function PersonPage({ params, searchParams }: { params: Promise<{ team: string; person: string }>; searchParams: Promise<{ month?: string; dim?: string }> }) {
  const { team, person } = await params;
  const sp = await searchParams;
  const month = sp.month ?? new Date().toISOString().slice(0, 7);
  const dim: Dim = sp.dim === "cost_type" ? "cost_type" : "vendor";
  const data = await getPersonExplore(getSupabaseAdminClient(), decodeURIComponent(team), person, month);
  return (
    <>
      <PageHeader title={data.title} subtitle="Individual spend — where it occurs and when." />
      <ExploreView data={data} initialDim={dim} />
    </>
  );
}
```

- [ ] **Step 4: Typecheck/build**

Run: `CI=true npm run build`
Expected: `✓ Compiled`, routes `/explore`, `/explore/[team]`, `/explore/[team]/[person]` listed.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/explore"
git commit -m "explore: company / team / individual pages"
```

---

## Task 15: Redirect old pages, repoint home, update nav

**Files:**
- Modify: `src/app/page.tsx`, `src/app/(dashboard)/overview/page.tsx`, `src/app/(dashboard)/departments/page.tsx`, `src/app/(dashboard)/people/page.tsx`, `src/components/nav.tsx`

- [ ] **Step 1: Repoint root + old pages to /explore**

Set each of these files' default export to redirect:

`src/app/page.tsx`:
```tsx
import { redirect } from "next/navigation";
export default function Home() { redirect("/explore"); }
```

`src/app/(dashboard)/overview/page.tsx`, `.../departments/page.tsx`, `.../people/page.tsx` (each, identical body):
```tsx
import { redirect } from "next/navigation";
export default function Page() { redirect("/explore"); }
```

- [ ] **Step 2: Update the sidebar nav**

In `src/components/nav.tsx`, replace the first three `PAGES` entries (overview/departments/people) with a single Explore entry, keeping the rest:

```tsx
const PAGES = [
  { href: "/explore", label: "Explore" },
  { href: "/api-platforms", label: "API Platforms" },
  { href: "/data-health", label: "Data Health" },
  { href: "/imports", label: "Imports", admin: true },
];
```

Update the active-state check so `/explore` is highlighted on `/explore` and its sub-routes: change the `active` computation to `const active = p.href === "/explore" ? pathname.startsWith("/explore") : pathname === p.href;`.

- [ ] **Step 3: Build**

Run: `CI=true npm run build`
Expected: compiles; `/overview`, `/departments`, `/people` still build (as redirects).

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx "src/app/(dashboard)/overview/page.tsx" "src/app/(dashboard)/departments/page.tsx" "src/app/(dashboard)/people/page.tsx" src/components/nav.tsx
git commit -m "explore: make it home; redirect old pages; nav -> Explore"
```

---

## Task 16: Smoke-test all three levels against the local DB

**Files:** none (verification)

- [ ] **Step 1: Ensure local Supabase + seed**

Run: `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"; npx supabase status >/dev/null 2>&1 || npx supabase start; npm run seed:dev`
Expected: seed prints `✅ spend_facts now holds N rows`.

- [ ] **Step 2: Start dev server (background) and fetch each level**

Run:
```bash
(npm run dev > /tmp/explore-dev.log 2>&1 &) ; sleep 6
curl -s -o /dev/null -w "company %{http_code}\n" "http://localhost:3000/explore"
TEAM=$(curl -s "http://localhost:3000/explore" | grep -oE '/explore/[^"/]+' | head -1 | sed 's#/explore/##')
curl -s -o /dev/null -w "team %{http_code}\n" "http://localhost:3000/explore/$TEAM"
PERSON=$(curl -s "http://localhost:3000/explore/$TEAM" | grep -oE "/explore/$TEAM/[a-f0-9-]+" | head -1)
curl -s -o /dev/null -w "person %{http_code}\n" "http://localhost:3000$PERSON"
curl -s -o /dev/null -w "old overview redirect %{http_code}\n" "http://localhost:3000/overview"
```
Expected: `company 200`, `team 200`, `person 200`, `old overview redirect 307`.
(`AUTH_DISABLED=true` must be set in `.env.local` so pages render without sign-in.)

- [ ] **Step 3: Verify content presence**

Run: `curl -s "http://localhost:3000/explore" | grep -oE "Teams|12-month trend|Where it" | sort -u`
Expected: shows `12-month trend`, `Teams`, `Where it`.

- [ ] **Step 4: Stop dev server**

Run: `lsof -ti:3000 | xargs kill 2>/dev/null; echo stopped`

- [ ] **Step 5: Full test + lint + build**

Run: `npm test && CI=true npm run lint && CI=true npm run build`
Expected: all tests pass, lint clean, build succeeds.

- [ ] **Step 6: Commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "explore: smoke-test fixes" --allow-empty
```

---

## Task 17: Ship (deploy + verify production)

**Files:** none

- [ ] **Step 1: Sync main + deploy**

Run:
```bash
git push origin scaffold-v1
git checkout main && git fetch origin -q && git reset --hard origin/main -q && git merge scaffold-v1 -q && git push origin main && git checkout scaffold-v1
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"; vercel --prod --force --yes
```
Expected: `READY`.

- [ ] **Step 2: Verify production home redirects + renders**

Run:
```bash
curl -s -o /dev/null -w "/ -> %{http_code} %{redirect_url}\n" "https://ai-costs-two.vercel.app/"
curl -s -o /dev/null -w "/explore -> %{http_code} loc=%{redirect_url}\n" "https://ai-costs-two.vercel.app/explore"
```
Expected: `/` → 307 → `/explore`; `/explore` → 307 → `/api/auth/signin` (auth gate, since prod has no AUTH_DISABLED). Sign in manually to confirm the drill-down renders.

---

## Self-Review

- **Spec coverage:** §3 routes → Tasks 13–15. §4 unified anatomy (4 blocks) → Tasks 8–12. Toggle (instant, both dims server-side) → Task 7 (`bothDims`) + Task 12. Treemap top-N+Other → Task 5. Ranked drill targets (team/person/lineitem) → Task 6. Individual daily trend + line items → Tasks 5/6/7/12. §5 data (12-month fetch, builders) → Tasks 2/7. §6 Motion/visual → Tasks 8/11/13. Redirects + nav → Task 15. Testing → shape tests (4–6) + smoke (16). All covered.
- **Placeholder scan:** every code step has full code; commands have expected output. None found.
- **Type consistency:** `ShapeFact` (shape.ts) ≈ `EnrichedFact + day` (common.ts) — Task 7 casts via `asShape`; both carry `day, source, costType, costUsd, employeeId, department, fullName, entityKey, model`. `ExploreData` fields produced by Task 7 match those consumed by Task 12. `Dim` used consistently. `rankPeople(rows, teamDept, employees)` signature matches its call in Task 7.
