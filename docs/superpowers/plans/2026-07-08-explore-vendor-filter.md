# Explore Vendor Drill-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope the whole Explore experience (Company → Team → Person) to one vendor via chips or by clicking a vendor in the composition chart, with the filter carried through drill-down links.

**Architecture:** All three Explore pages render the shared `ExploreView`, so the feature is: a pure param/validation helper, a one-line facts filter upstream of the untouched shapers, chips UI + URL sync in `ExploreView`, an optional `onSelect` on `CompositionBreakdown`, and an optional `linkQuery` appended to ranked-list hrefs.

**Tech Stack:** React client components, Next.js App Router searchParams, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-08-explore-vendor-filter-design.md`

## Global Constraints

- Unknown/absent `?vendor=` or a vendor not present in the scope → `"all"`.
- With a vendor selected: charts/split bars use `cost_type`, the dim toggle is hidden, `dim` state is preserved.
- Selecting "all" removes the `vendor` param from the URL (never `vendor=all`).
- Colors/labels only from `VENDOR_COLORS` / `VENDOR_LABEL`.
- No shaper (`shape.ts`/`build.ts`) changes.
- Working branch: `explore-vendor-filter`. `npm run test` before each commit; `CI=true npm run build` before finishing.

---

### Task 1: `vendor-filter` helpers

**Files:**
- Create: `src/lib/explore/vendor-filter.ts`
- Test: `src/lib/explore/vendor-filter.test.ts`

**Interfaces:**
- Consumes: `Vendor`, `VENDOR_LABEL` from `@/lib/types`; `ShapeFact` from `./shape`.
- Produces: `vendorsInFacts(facts: Pick<ShapeFact, "source">[]): Vendor[]` (unique, label-sorted) and `parseVendorParam(param: string | undefined, present: Vendor[]): Vendor | "all"`. Task 3 imports both from `@/lib/explore/vendor-filter`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/explore/vendor-filter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseVendorParam, vendorsInFacts } from "./vendor-filter";

describe("vendorsInFacts", () => {
  it("returns unique vendors sorted by display label", () => {
    const facts = [
      { source: "openai" as const },
      { source: "anthropic" as const },
      { source: "openai" as const },
      { source: "cursor" as const },
    ];
    // Labels: Anthropic, Cursor, OpenAI
    expect(vendorsInFacts(facts)).toEqual(["anthropic", "cursor", "openai"]);
  });

  it("returns [] for no facts", () => {
    expect(vendorsInFacts([])).toEqual([]);
  });
});

describe("parseVendorParam", () => {
  const present = ["anthropic", "cursor"] as const;

  it("accepts a vendor that is present", () => {
    expect(parseVendorParam("cursor", [...present])).toBe("cursor");
  });

  it("falls back to all when absent, unknown, or not present in scope", () => {
    expect(parseVendorParam(undefined, [...present])).toBe("all");
    expect(parseVendorParam("not-a-vendor", [...present])).toBe("all");
    expect(parseVendorParam("openai", [...present])).toBe("all"); // valid vendor, no data in scope
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/explore/vendor-filter.test.ts`
Expected: FAIL — cannot resolve `./vendor-filter`.

- [ ] **Step 3: Write the helpers**

Create `src/lib/explore/vendor-filter.ts`:

```ts
import type { Vendor } from "@/lib/types";
import { VENDOR_LABEL } from "@/lib/types";
import type { ShapeFact } from "./shape";

/** Unique vendors present in the facts, sorted by display label. */
export function vendorsInFacts(facts: Pick<ShapeFact, "source">[]): Vendor[] {
  return [...new Set(facts.map((f) => f.source))].sort((a, b) =>
    VENDOR_LABEL[a].localeCompare(VENDOR_LABEL[b]),
  );
}

/** Validate a ?vendor= param against the vendors actually present in scope. */
export function parseVendorParam(param: string | undefined, present: Vendor[]): Vendor | "all" {
  return present.includes(param as Vendor) ? (param as Vendor) : "all";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/explore/vendor-filter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/explore/vendor-filter.ts src/lib/explore/vendor-filter.test.ts
git commit -m "feat: vendor-filter helpers for Explore"
```

---

### Task 2: Leaf components — clickable composition + link query

**Files:**
- Modify: `src/components/explore/composition-breakdown.tsx`
- Modify: `src/components/explore/ranked-list.tsx`
- Modify: `src/components/explore/ranked-panel.tsx`

**Interfaces:**
- Produces: `CompositionBreakdown({ nodes, onSelect }: { nodes: TreemapNode[]; onSelect?: (key: string) => void })`; `RankedList({ rows, dim, linkQuery }: { rows: RankRow[]; dim: Dim; linkQuery?: string })`; `RankedPanel` gains and forwards `linkQuery?: string`. Task 3 uses all three.

- [ ] **Step 1: Make composition rows selectable**

In `src/components/explore/composition-breakdown.tsx`, replace the exported function with:

```tsx
export function CompositionBreakdown({ nodes, onSelect }: { nodes: TreemapNode[]; onSelect?: (key: string) => void }) {
  const reduce = useReducedMotion();
  if (!nodes.length) return <div className="flex h-40 items-center justify-center text-sm text-muted">No spend in this period.</div>;
  const total = nodes.reduce((s, n) => s + n.value, 0);
  const max = Math.max(...nodes.map((n) => n.value), 0);
  return (
    <div className="space-y-2.5">
      {nodes.map((n, i) => {
        const row = (
          <>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: n.color }} />
                <span className="truncate">{n.label}</span>
              </span>
              <span className="shrink-0 tabular-nums">
                {formatUsd(n.value)}
                <span className="ml-2 text-xs text-muted">{total > 0 ? `${((n.value / total) * 100).toFixed(0)}%` : ""}</span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <motion.div
                className="h-full rounded-full"
                style={{ background: n.color }}
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${max > 0 ? (n.value / max) * 100 : 0}%` }}
                transition={{ duration: 0.4, delay: Math.min(i, 12) * 0.03, ease: [0.16, 1, 0.3, 1] }}
              />
            </div>
          </>
        );
        return onSelect ? (
          <button
            key={n.key}
            type="button"
            onClick={() => onSelect(n.key)}
            title={`Filter to ${n.label}`}
            className="-mx-1.5 block w-[calc(100%+0.75rem)] rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-2/60"
          >
            {row}
          </button>
        ) : (
          <div key={n.key}>{row}</div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Append the link query in RankedList**

In `src/components/explore/ranked-list.tsx`:

- Change `Row`'s signature and href handling:

```tsx
function Row({ r, max, i, dim, linkQuery }: { r: RankRow; max: number; i: number; dim: Dim; linkQuery?: string }) {
```

and its last line:

```tsx
  const href = r.href && linkQuery ? `${r.href}?${linkQuery}` : r.href;
  return href ? <Link href={href} className="block">{body}</Link> : body;
```

- Change `RankedList`:

```tsx
export function RankedList({ rows, dim, linkQuery }: { rows: RankRow[]; dim: Dim; linkQuery?: string }) {
  if (!rows.length) return <p className="text-sm text-muted">No spend in this period.</p>;
  const max = Math.max(...rows.map((r) => r.total), 0);
  return <div className="space-y-2">{rows.map((r, i) => <Row key={r.id} r={r} max={max} i={i} dim={dim} linkQuery={linkQuery} />)}</div>;
}
```

- [ ] **Step 3: Forward linkQuery through RankedPanel**

In `src/components/explore/ranked-panel.tsx`, change the signature and the final `RankedList` call:

```tsx
export function RankedPanel({ ranked, allStaff, dim, linkQuery }: { ranked: ExploreData["ranked"]; allStaff?: RankRow[]; dim: Dim; linkQuery?: string }) {
```

```tsx
      <RankedList rows={rows} dim={dim} linkQuery={linkQuery} />
```

- [ ] **Step 4: Lint, typecheck, commit**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean.

```bash
git add src/components/explore/composition-breakdown.tsx src/components/explore/ranked-list.tsx src/components/explore/ranked-panel.tsx
git commit -m "feat: selectable composition rows + drill-down links carry query"
```

---

### Task 3: ExploreView filter + chips, pages, changelog

**Files:**
- Modify: `src/components/explore/explore-view.tsx`
- Modify: `src/app/(dashboard)/explore/page.tsx`
- Modify: `src/app/(dashboard)/explore/[team]/page.tsx`
- Modify: `src/app/(dashboard)/explore/[team]/[person]/page.tsx`
- Modify: `src/lib/changelog.ts`

**Interfaces:**
- Consumes: `vendorsInFacts`, `parseVendorParam` (Task 1); `CompositionBreakdown.onSelect`, `RankedPanel.linkQuery` (Task 2); `VENDOR_LABEL`, `VENDOR_COLORS`.
- Produces: `ExploreView` gains optional `initialVendorParam?: string`.

- [ ] **Step 1: Rework ExploreView**

Replace the entire contents of `src/components/explore/explore-view.tsx` with:

```tsx
"use client";

import { useMemo, useState } from "react";
import type { Dim } from "@/lib/explore/types";
import type { Vendor } from "@/lib/types";
import { VENDOR_LABEL } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { parsePeriod, allTimePeriod, type Period } from "@/lib/explore/period";
import { buildExploreData, type RawScope } from "@/lib/explore/build";
import { parseVendorParam, vendorsInFacts } from "@/lib/explore/vendor-filter";
import { cn } from "@/lib/utils";
import { Scorecards } from "./scorecards";
import { TrendChart } from "./trend-chart";
import { CompositionBreakdown } from "./composition-breakdown";
import { RankedPanel } from "./ranked-panel";
import { PeriodControl } from "./period-control";

/** Mirror state into a query param without a navigation/refetch. */
function syncParam(key: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  window.history.replaceState(null, "", url);
}

function Toggle({ dim, onChange }: { dim: Dim; onChange: (d: Dim) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
      {(["vendor", "cost_type"] as Dim[]).map((d) => (
        <button
          key={d}
          onClick={() => { onChange(d); syncParam("dim", d); }}
          className={cn("rounded px-2.5 py-1 transition-colors", dim === d ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
        >
          {d === "vendor" ? "By vendor" : "By cost type"}
        </button>
      ))}
    </div>
  );
}

function VendorChips({ vendors, active, onChange }: { vendors: Vendor[]; active: Vendor | "all"; onChange: (v: Vendor | "all") => void }) {
  if (vendors.length < 2) return null; // a filter with one option is noise
  return (
    <div className="inline-flex flex-wrap items-center rounded-md border border-border bg-surface-2 p-0.5 text-xs">
      <button
        type="button"
        onClick={() => onChange("all")}
        className={cn("rounded px-2.5 py-1 transition-colors", active === "all" ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
      >
        All
      </button>
      {vendors.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(active === v ? "all" : v)}
          className={cn("flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors", active === v ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
        >
          <span className="size-2 rounded-full" style={{ background: VENDOR_COLORS[v] }} />
          {VENDOR_LABEL[v]}
        </button>
      ))}
    </div>
  );
}

export function ExploreView({
  scope,
  initialPeriodParam,
  initialDim,
  initialVendorParam,
}: {
  scope: RawScope;
  initialPeriodParam?: string;
  initialDim: Dim;
  initialVendorParam?: string;
}) {
  const vendors = useMemo(() => vendorsInFacts(scope.facts), [scope.facts]);

  const [period, setPeriod] = useState<Period>(() =>
    initialPeriodParam === "all" ? allTimePeriod(scope.earliest, new Date()) : parsePeriod(initialPeriodParam, new Date()),
  );
  const [dim, setDim] = useState<Dim>(initialDim);
  const [vendor, setVendor] = useState<Vendor | "all">(() => parseVendorParam(initialVendorParam, vendors));

  // Vendor filter slices upstream of the shapers, so every panel (including
  // total-to-date) is vendor-scoped. Pure, in-memory — no network round-trip.
  const facts = useMemo(
    () => (vendor === "all" ? scope.facts : scope.facts.filter((f) => f.source === vendor)),
    [scope.facts, vendor],
  );
  const data = useMemo(() => buildExploreData({ ...scope, facts }, period), [scope, facts, period]);

  // A single-vendor "by vendor" chart is one flat color — show cost type
  // instead. `dim` is preserved and restored when the filter clears.
  const effectiveDim: Dim = vendor === "all" ? dim : "cost_type";

  const changePeriod = (p: Period) => { setPeriod(p); syncParam("period", p.anchor); };
  const changeVendor = (v: Vendor | "all") => { setVendor(v); syncParam("vendor", v === "all" ? null : v); };

  // Drill-down links keep the current period/dim/vendor context.
  const linkQuery = useMemo(() => {
    const q = new URLSearchParams({ period: period.anchor, dim });
    if (vendor !== "all") q.set("vendor", vendor);
    return q.toString();
  }, [period.anchor, dim, vendor]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PeriodControl period={period} earliest={scope.earliest} onChange={changePeriod} />
        <div className="flex flex-wrap items-center gap-3">
          <VendorChips vendors={vendors} active={vendor} onChange={changeVendor} />
          {vendor === "all" && <Toggle dim={dim} onChange={setDim} />}
        </div>
      </div>

      <Scorecards totalToDate={data.totalToDate} sc={data.scorecard} periodLabel={data.period.label} />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium">Trend · {data.period.label}</h2>
          <TrendChart data={data.trend[effectiveDim]} dim={effectiveDim} />
        </section>

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium">Where it&rsquo;s going · {data.period.label}</h2>
          <CompositionBreakdown
            nodes={data.treemap[effectiveDim]}
            onSelect={effectiveDim === "vendor" ? (key) => changeVendor(key as Vendor) : undefined}
          />
        </section>
      </div>

      <RankedPanel ranked={data.ranked} allStaff={data.allStaff} dim={effectiveDim} linkQuery={linkQuery} />
    </div>
  );
}
```

- [ ] **Step 2: Pass the vendor param on all three pages**

In each of `src/app/(dashboard)/explore/page.tsx`, `src/app/(dashboard)/explore/[team]/page.tsx`, `src/app/(dashboard)/explore/[team]/[person]/page.tsx`:

- extend the searchParams type: `Promise<{ period?: string; dim?: string; vendor?: string }>`
- pass the prop: `<ExploreView scope={scope} initialPeriodParam={sp.period} initialDim={dim} initialVendorParam={sp.vendor} />`

- [ ] **Step 3: Changelog**

In `src/lib/changelog.ts`, append to the `2026-07-08` entry's `items`:

```ts
      "Explore can now be filtered to a single vendor — use the chips at the top or click a vendor in the composition chart; the filter follows you as you drill into teams and people.",
```

- [ ] **Step 4: Full test suite and production build**

Run: `npm run test`
Expected: all pass (127 existing + 4 new = 131).

Run: `CI=true npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/explore/explore-view.tsx "src/app/(dashboard)/explore/page.tsx" "src/app/(dashboard)/explore/[team]/page.tsx" "src/app/(dashboard)/explore/[team]/[person]/page.tsx" src/lib/changelog.ts
git commit -m "feat: vendor drill-down filter on Explore (chips + click-to-filter)"
```
