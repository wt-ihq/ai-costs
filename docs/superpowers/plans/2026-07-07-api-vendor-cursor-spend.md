# API Vendor Spend/Filter + Cursor Spend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API Platforms page gains per-vendor spend tiles that double as a filter plus a spend-by-person panel; Cursor Usage page gains spend tiles, overage-spend-by-model, and spend-by-person panels.

**Architecture:** No new server round-trips for the API page — the existing scope already carries `source` on every row, so vendor totals, filtering, and person grouping are client-side slices via pure shapers. The Cursor page gets one new paginated read (`getCursorSpendScope`) over `spend_facts` (`source=cursor`, seat+overage) and a pure `buildCursorSpendData` shaper, mirroring the existing scope→shaper pattern.

**Tech Stack:** Next.js 16 App Router server pages + client views, Supabase JS, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-api-vendor-cursor-spend-design.md`

## Global Constraints

- Page name, nav label, and URL stay "API Platforms" / `/api-platforms` (user decision — no rename).
- Every `spend_facts` read paginates with `.order("day").order("id").range(...)` in a loop (CLAUDE.md gotcha #1).
- Windows are exclusive-end (`.gte(from).lt(toExclusive)`).
- Colors come from `VENDOR_COLORS` (`src/lib/colors.ts`) and theme tokens — no new hex values in components.
- Null owner/person groups as `"Unattributed"`; empty overage model groups as `"(no model)"`.
- Run `npm run test` before each commit; `CI=true npm run build` before finishing (repo rule for query changes).
- Working branch: `api-vendor-cursor-spend`.

---

### Task 1: API pure shapers — `buildVendorTotals` + `buildPersonRows`

**Files:**
- Modify: `src/lib/queries/api-platforms.ts` (append after `buildPlatformRows`, before `nextMonth`)
- Test: `src/lib/queries/api-platforms.test.ts` (create)

**Interfaces:**
- Consumes: existing `PlatformFactRow` (`{ source: Vendor; entityKey: string; model: string; costUsd: number; ownerName: string | null }`) from the same file.
- Produces: `buildVendorTotals(rows: PlatformFactRow[]): Map<Vendor, number>` and `buildPersonRows(rows: PlatformFactRow[]): { name: string; total: number }[]` (sorted by total desc, `null` owner → `"Unattributed"`). Task 2 imports both from `@/lib/queries/api-platforms`.

- [x] **Step 1: Write the failing test**

Create `src/lib/queries/api-platforms.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPersonRows, buildVendorTotals, type PlatformFactRow } from "./api-platforms";

const row = (over: Partial<PlatformFactRow>): PlatformFactRow => ({
  source: "anthropic",
  entityKey: "key_1",
  model: "claude-sonnet-5",
  costUsd: 10,
  ownerName: "Ada Lovelace",
  ...over,
});

describe("buildVendorTotals", () => {
  it("sums cost per vendor", () => {
    const totals = buildVendorTotals([
      row({ costUsd: 10 }),
      row({ costUsd: 5 }),
      row({ source: "openai", costUsd: 7 }),
    ]);
    expect(totals.get("anthropic")).toBe(15);
    expect(totals.get("openai")).toBe(7);
    expect(totals.size).toBe(2);
  });

  it("returns an empty map for no rows", () => {
    expect(buildVendorTotals([]).size).toBe(0);
  });
});

describe("buildPersonRows", () => {
  it("groups by owner, buckets null as Unattributed, sorts by total desc", () => {
    const people = buildPersonRows([
      row({ ownerName: "Ada Lovelace", costUsd: 5 }),
      row({ ownerName: "Grace Hopper", costUsd: 20 }),
      row({ ownerName: "Ada Lovelace", costUsd: 10 }),
      row({ ownerName: null, costUsd: 1 }),
    ]);
    expect(people).toEqual([
      { name: "Grace Hopper", total: 20 },
      { name: "Ada Lovelace", total: 15 },
      { name: "Unattributed", total: 1 },
    ]);
  });

  it("returns [] for no rows", () => {
    expect(buildPersonRows([])).toEqual([]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/queries/api-platforms.test.ts`
Expected: FAIL — `buildVendorTotals` / `buildPersonRows` are not exported.

- [x] **Step 3: Implement the shapers**

In `src/lib/queries/api-platforms.ts`, after the `buildPlatformRows` function, add:

```ts
/** Pure: metered total per vendor (for the tile row / filter). */
export function buildVendorTotals(rows: PlatformFactRow[]): Map<Vendor, number> {
  const totals = new Map<Vendor, number>();
  for (const r of rows) totals.set(r.source, (totals.get(r.source) ?? 0) + r.costUsd);
  return totals;
}

/** Pure: metered spend per owner; ownerless keys bucket as "Unattributed". */
export function buildPersonRows(rows: PlatformFactRow[]): { name: string; total: number }[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const name = r.ownerName ?? "Unattributed";
    totals.set(name, (totals.get(name) ?? 0) + r.costUsd);
  }
  return [...totals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/queries/api-platforms.test.ts`
Expected: PASS (4 tests).

- [x] **Step 5: Commit**

```bash
git add src/lib/queries/api-platforms.ts src/lib/queries/api-platforms.test.ts
git commit -m "feat: vendor-total and person-spend shapers for API Platforms"
```

---

### Task 2: API Platforms view — vendor tiles/filter + spend-by-person

**Files:**
- Modify: `src/components/api-platforms/api-platforms-view.tsx` (full rewrite below)
- Modify: `src/app/(dashboard)/api-platforms/page.tsx` (pass `vendor` param; subtitle)

**Interfaces:**
- Consumes: `buildVendorTotals`, `buildPersonRows` (Task 1); existing `buildPlatformRows`, `ApiPlatformsScope`, `PeriodControl`, `Panel`, `VENDOR_LABEL`, `VENDOR_COLORS`, `cn`, `formatUsd`.
- Produces: `ApiPlatformsView` accepts a new optional `initialVendorParam?: string` prop.

- [x] **Step 1: Rewrite the view**

Replace the entire contents of `src/components/api-platforms/api-platforms-view.tsx` with:

```tsx
"use client";

import { useMemo, useState } from "react";
import {
  buildPersonRows,
  buildPlatformRows,
  buildVendorTotals,
  type ApiPlatformsScope,
} from "@/lib/queries/api-platforms";
import { allTimePeriod, parsePeriod, type Period } from "@/lib/explore/period";
import { PeriodControl } from "@/components/explore/period-control";
import { Panel } from "@/components/ui";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { cn, formatUsd } from "@/lib/utils";

export function ApiPlatformsView({
  scope,
  initialPeriodParam,
  initialVendorParam,
}: {
  scope: ApiPlatformsScope;
  initialPeriodParam?: string;
  initialVendorParam?: string;
}) {
  // Vendors present anywhere in the scope — a stable tile set across periods.
  const vendors = useMemo(
    () =>
      [...new Set(scope.rows.map((r) => r.source))].sort((a, b) =>
        VENDOR_LABEL[a].localeCompare(VENDOR_LABEL[b]),
      ),
    [scope.rows],
  );

  const [period, setPeriod] = useState<Period>(() =>
    initialPeriodParam === "all" ? allTimePeriod(scope.earliest, new Date()) : parsePeriod(initialPeriodParam, new Date()),
  );
  // Unknown or absent ?vendor= behaves as All.
  const [vendor, setVendor] = useState<Vendor | "all">(() =>
    vendors.includes(initialVendorParam as Vendor) ? (initialVendorParam as Vendor) : "all",
  );

  const nameByKey = useMemo(() => new Map(scope.names), [scope.names]);
  const inPeriod = useMemo(
    () => scope.rows.filter((r) => r.day >= period.from && r.day < period.toExclusive),
    [scope.rows, period],
  );
  const totals = useMemo(() => buildVendorTotals(inPeriod), [inPeriod]);
  const grandTotal = useMemo(() => [...totals.values()].reduce((s, v) => s + v, 0), [totals]);
  const filtered = useMemo(
    () => (vendor === "all" ? inPeriod : inPeriod.filter((r) => r.source === vendor)),
    [inPeriod, vendor],
  );
  const entities = useMemo(() => buildPlatformRows(filtered, nameByKey), [filtered, nameByKey]);
  const people = useMemo(() => buildPersonRows(filtered), [filtered]);
  const peopleTotal = useMemo(() => people.reduce((s, p) => s + p.total, 0), [people]);

  const syncUrl = (mutate: (url: URL) => void) => {
    const url = new URL(window.location.href);
    mutate(url);
    window.history.replaceState(null, "", url);
  };
  const changePeriod = (p: Period) => {
    setPeriod(p);
    syncUrl((u) => u.searchParams.set("period", p.anchor));
  };
  // Clicking the active vendor tile clears the filter back to All.
  const changeVendor = (v: Vendor | "all") => {
    const next = v === vendor ? "all" : v;
    setVendor(next);
    syncUrl((u) => (next === "all" ? u.searchParams.delete("vendor") : u.searchParams.set("vendor", next)));
  };

  const tileClasses = (active: boolean) =>
    cn(
      "rounded-xl border bg-surface p-4 text-left transition-colors",
      active ? "border-accent" : "border-border hover:border-accent/40",
    );

  return (
    <div className="space-y-6">
      <PeriodControl period={period} earliest={scope.earliest} onChange={changePeriod} />

      {/* Vendor spend tiles double as the vendor filter. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <button type="button" onClick={() => changeVendor("all")} aria-pressed={vendor === "all"} className={tileClasses(vendor === "all")}>
          <span className="text-xs uppercase tracking-wide text-muted">All vendors</span>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{formatUsd(grandTotal)}</div>
        </button>
        {vendors.map((v) => (
          <button key={v} type="button" onClick={() => changeVendor(v)} aria-pressed={vendor === v} className={tileClasses(vendor === v)}>
            <span className="flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ background: VENDOR_COLORS[v] }} />
              <span className="text-xs uppercase tracking-wide text-muted">{VENDOR_LABEL[v]}</span>
            </span>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{formatUsd(totals.get(v) ?? 0)}</div>
          </button>
        ))}
      </div>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Spend by person · {period.label}</h2>
        <Panel>
          {people.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted">No metered spend in {period.label}.</div>
          ) : (
            <ul className="space-y-1.5">
              {people.map((p) => (
                <li key={p.name} className="flex items-center gap-3 text-sm">
                  <span className="w-48 shrink-0 truncate">{p.name}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${peopleTotal > 0 ? (p.total / peopleTotal) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right tabular-nums">{formatUsd(p.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

      {entities.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted">No metered spend in {period.label}.</p>
        </Panel>
      ) : (
        <div className="grid gap-4">
          {entities.map((e) => (
            <Panel key={`${e.source}:${e.entityKey}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full" style={{ background: VENDOR_COLORS[e.source] }} />
                    <span className="text-xs uppercase tracking-wide text-muted">{VENDOR_LABEL[e.source]}</span>
                  </div>
                  <h2 className="mt-1 font-medium">{e.name}</h2>
                  <p className="text-xs text-muted">
                    {e.entityKey}
                    {e.owner ? ` · owner ${e.owner}` : " · unattributed"}
                  </p>
                </div>
                <span className="text-lg font-semibold tabular-nums">{formatUsd(e.total)}</span>
              </div>

              <div className="mt-4 space-y-1.5">
                {e.models.map((m) => (
                  <div key={m.model} className="flex items-center gap-3 text-sm">
                    <span className="w-48 shrink-0 truncate font-mono text-xs text-muted">{m.model || "(no model)"}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${e.total > 0 ? (m.cost / e.total) * 100 : 0}%`, background: VENDOR_COLORS[e.source] }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right tabular-nums">{formatUsd(m.cost)}</span>
                  </div>
                ))}
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 2: Pass the vendor param and update the subtitle**

In `src/app/(dashboard)/api-platforms/page.tsx`, change the `searchParams` type and the two JSX spots:

```tsx
export default async function ApiPlatformsPage({ searchParams }: { searchParams: Promise<{ period?: string; vendor?: string }> }) {
  const sp = await searchParams;
  const scope = await getApiPlatformsScope(getSupabaseAdminClient());

  return (
    <>
      <PageHeader
        title="API Platforms"
        subtitle="Metered spend by vendor, key/project, and person, with model breakdown."
      />
      <ApiPlatformsView scope={scope} initialPeriodParam={sp.period} initialVendorParam={sp.vendor} />
    </>
  );
}
```

- [x] **Step 3: Lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean.

- [x] **Step 4: Commit**

```bash
git add src/components/api-platforms/api-platforms-view.tsx "src/app/(dashboard)/api-platforms/page.tsx"
git commit -m "feat: vendor spend tiles + filter and spend-by-person on API Platforms"
```

---

### Task 3: Cursor spend scope query + shaper

**Files:**
- Create: `src/lib/queries/cursor-spend.ts`
- Create: `src/lib/cursor-models/spend-shape.ts`
- Test: `src/lib/cursor-models/spend-shape.test.ts` (create)

**Interfaces:**
- Consumes: `earliestFactDay` from `src/lib/queries/common.ts`; `Period` from `@/lib/explore/period`.
- Produces: `getCursorSpendScope(supabase: SupabaseClient): Promise<CursorSpendScope>` where `CursorSpendScope = { rows: CursorSpendRow[] }` and `CursorSpendRow = { day: string; costType: "seat" | "overage"; model: string; costUsd: number; personName: string | null }`; `buildCursorSpendData(scope: CursorSpendScope, period: Period): CursorSpendData` where `CursorSpendData = { total: number; seat: number; overage: number; byModel: { model: string; cost: number }[]; byPerson: { name: string; cost: number }[] }`. Task 4 imports these.

- [x] **Step 1: Write the failing shaper test**

Create `src/lib/cursor-models/spend-shape.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Period } from "@/lib/explore/period";
import type { CursorSpendRow } from "@/lib/queries/cursor-spend";
import { buildCursorSpendData } from "./spend-shape";

const JUNE: Period = {
  granularity: "month",
  anchor: "2026-06",
  from: "2026-06-01",
  toExclusive: "2026-07-01",
  label: "June 2026",
  isCurrent: false,
};

const row = (over: Partial<CursorSpendRow>): CursorSpendRow => ({
  day: "2026-06-10",
  costType: "overage",
  model: "claude-sonnet-5",
  costUsd: 10,
  personName: "Ada Lovelace",
  ...over,
});

describe("buildCursorSpendData", () => {
  it("slices by period and splits seat vs overage", () => {
    const data = buildCursorSpendData(
      {
        rows: [
          row({ costType: "seat", model: "", costUsd: 40 }),
          row({ costUsd: 12 }),
          row({ day: "2026-07-01", costUsd: 99 }), // outside (exclusive end)
          row({ day: "2026-05-31", costUsd: 99 }), // outside
        ],
      },
      JUNE,
    );
    expect(data.seat).toBe(40);
    expect(data.overage).toBe(12);
    expect(data.total).toBe(52);
  });

  it("groups overage by model with (no model) bucket, sorted desc", () => {
    const data = buildCursorSpendData(
      {
        rows: [
          row({ model: "claude-sonnet-5", costUsd: 5 }),
          row({ model: "", costUsd: 2 }),
          row({ model: "gpt-5", costUsd: 8 }),
          row({ costType: "seat", model: "", costUsd: 40 }), // seats never enter byModel
        ],
      },
      JUNE,
    );
    expect(data.byModel).toEqual([
      { model: "gpt-5", cost: 8 },
      { model: "claude-sonnet-5", cost: 5 },
      { model: "(no model)", cost: 2 },
    ]);
  });

  it("groups seat+overage by person with Unattributed bucket, sorted desc", () => {
    const data = buildCursorSpendData(
      {
        rows: [
          row({ personName: "Ada Lovelace", costType: "seat", model: "", costUsd: 40 }),
          row({ personName: "Ada Lovelace", costUsd: 3 }),
          row({ personName: null, costUsd: 7 }),
          row({ personName: "Grace Hopper", costUsd: 50 }),
        ],
      },
      JUNE,
    );
    expect(data.byPerson).toEqual([
      { name: "Grace Hopper", cost: 50 },
      { name: "Ada Lovelace", cost: 43 },
      { name: "Unattributed", cost: 7 },
    ]);
  });

  it("handles empty input", () => {
    const data = buildCursorSpendData({ rows: [] }, JUNE);
    expect(data).toEqual({ total: 0, seat: 0, overage: 0, byModel: [], byPerson: [] });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/cursor-models/spend-shape.test.ts`
Expected: FAIL — cannot resolve `./spend-shape` / `@/lib/queries/cursor-spend`.

- [x] **Step 3: Write the query module**

Create `src/lib/queries/cursor-spend.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { earliestFactDay } from "./common";

/** One Cursor spend fact, enriched with the attributed employee's name. */
export interface CursorSpendRow {
  day: string; // YYYY-MM-DD
  costType: "seat" | "overage";
  model: string; // "" for seat facts
  costUsd: number;
  personName: string | null; // null when unmatched
}

export interface CursorSpendScope {
  rows: CursorSpendRow[];
}

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

/** Fetch the full Cursor seat+overage window once; the client slices by period. */
export async function getCursorSpendScope(supabase: SupabaseClient): Promise<CursorSpendScope> {
  const now = new Date();
  const firstDay = await earliestFactDay(supabase);
  const from = (firstDay ?? now.toISOString().slice(0, 10)).slice(0, 7) + "-01";
  const toExclusive = nextMonth(now.toISOString().slice(0, 7));

  const PAGE = 1000;
  const rows: CursorSpendRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("day, cost_type, model, cost_usd, employees(full_name)")
      .eq("source", "cursor")
      .in("cost_type", ["seat", "overage"])
      .gte("day", from)
      .lt("day", toExclusive)
      // id tiebreaker keeps page boundaries stable across queries.
      .order("day")
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`getCursorSpendScope: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const emp = Array.isArray(r.employees) ? r.employees[0] : r.employees;
      rows.push({
        day: r.day as string,
        costType: r.cost_type as "seat" | "overage",
        model: (r.model as string) ?? "",
        costUsd: Number(r.cost_usd),
        personName: (emp as { full_name: string | null } | undefined)?.full_name ?? null,
      });
    }
    if (data.length < PAGE) break;
  }
  return { rows };
}
```

- [x] **Step 4: Write the shaper**

Create `src/lib/cursor-models/spend-shape.ts`:

```ts
import type { CursorSpendRow, CursorSpendScope } from "@/lib/queries/cursor-spend";
import type { Period } from "@/lib/explore/period";

export type { CursorSpendRow, CursorSpendScope };

export interface CursorSpendData {
  total: number;
  seat: number;
  overage: number;
  byModel: { model: string; cost: number }[]; // overage only
  byPerson: { name: string; cost: number }[]; // seat + overage
}

/** Pure: slice the scope to the period and aggregate spend. */
export function buildCursorSpendData(scope: CursorSpendScope, period: Period): CursorSpendData {
  const rows = scope.rows.filter((r) => r.day >= period.from && r.day < period.toExclusive);

  let seat = 0;
  let overage = 0;
  const modelTotals = new Map<string, number>();
  const personTotals = new Map<string, number>();
  for (const r of rows) {
    if (r.costType === "seat") {
      seat += r.costUsd;
    } else {
      overage += r.costUsd;
      const model = r.model || "(no model)";
      modelTotals.set(model, (modelTotals.get(model) ?? 0) + r.costUsd);
    }
    const person = r.personName ?? "Unattributed";
    personTotals.set(person, (personTotals.get(person) ?? 0) + r.costUsd);
  }

  return {
    total: seat + overage,
    seat,
    overage,
    byModel: [...modelTotals.entries()]
      .map(([model, cost]) => ({ model, cost }))
      .sort((a, b) => b.cost - a.cost),
    byPerson: [...personTotals.entries()]
      .map(([name, cost]) => ({ name, cost }))
      .sort((a, b) => b.cost - a.cost),
  };
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/cursor-models/spend-shape.test.ts`
Expected: PASS (4 tests).

- [x] **Step 6: Commit**

```bash
git add src/lib/queries/cursor-spend.ts src/lib/cursor-models/spend-shape.ts src/lib/cursor-models/spend-shape.test.ts
git commit -m "feat: Cursor spend scope query + buildCursorSpendData shaper"
```

---

### Task 4: Cursor Usage page — spend tiles + panels

**Files:**
- Modify: `src/app/(dashboard)/cursor-models/page.tsx`
- Modify: `src/components/cursor-models/teams-model-view.tsx`

**Interfaces:**
- Consumes: `getCursorSpendScope` + `CursorSpendScope` (Task 3 query), `buildCursorSpendData` (Task 3 shaper), existing `Panel`, `formatUsd`, `VENDOR_COLORS`.
- Produces: `TeamsModelView` gains a required `spend: CursorSpendScope` prop.

- [x] **Step 1: Fetch spend in the page and update the subtitle**

In `src/app/(dashboard)/cursor-models/page.tsx`:

Add imports:

```tsx
import { getCursorSpendScope } from "@/lib/queries/cursor-spend";
```

Change the header subtitle:

```tsx
  const header = (
    <PageHeader title="Cursor usage" subtitle="Cursor model adoption and spend by model, team, and person." />
  );
```

Change the Teams-plan branch to fetch both scopes concurrently (the Enterprise
branch and `EnterpriseLocked` fallback stay as-is):

```tsx
  // Teams plan: fall back to the per-user most-used-model signal if we have it;
  // otherwise show the Enterprise-only state.
  const [topModel, spend] = await Promise.all([
    getCursorTopModelScope(supabase),
    getCursorSpendScope(supabase),
  ]);
  return (
    <>
      {header}
      {topModel.rows.length > 0 ? (
        <TeamsModelView scope={topModel} spend={spend} initialPeriodParam={sp.period} />
      ) : (
        <EnterpriseLocked />
      )}
    </>
  );
```

- [x] **Step 2: Add spend to TeamsModelView**

In `src/components/cursor-models/teams-model-view.tsx`:

Add imports:

```tsx
import { buildCursorSpendData, type CursorSpendScope } from "@/lib/cursor-models/spend-shape";
import { VENDOR_COLORS } from "@/lib/colors";
import { formatCount, formatUsd } from "@/lib/utils";
```

(`formatCount` is already imported — extend that line rather than duplicating it.)

Change the signature:

```tsx
export function TeamsModelView({
  scope,
  spend,
  initialPeriodParam,
}: {
  scope: { rows: TopModelRow[]; earliest: string };
  spend: CursorSpendScope;
  initialPeriodParam?: string;
}) {
```

After the existing `const data = useMemo(...)` line add:

```tsx
  const spendData = useMemo(() => buildCursorSpendData(spend, period), [spend, period]);
```

In the tile grid (`<div className="grid grid-cols-2 gap-4 lg:grid-cols-3">`), append three tiles after the existing "Top model" tile:

```tsx
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Cursor spend</span>
          <span className="text-2xl font-semibold tabular-nums">{formatUsd(spendData.total)}</span>
          <span className="text-xs text-muted">{data.period.label}</span>
        </Panel>
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Seats</span>
          <span className="text-2xl font-semibold tabular-nums">{formatUsd(spendData.seat)}</span>
          <span className="text-xs text-muted">seat fees</span>
        </Panel>
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Overage</span>
          <span className="text-2xl font-semibold tabular-nums">{formatUsd(spendData.overage)}</span>
          <span className="text-xs text-muted">usage beyond the plan</span>
        </Panel>
```

After the existing closing `</div>` of the two-column grid (the one holding "Primary model across the team" and "By person"), add a second two-column grid:

```tsx
      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">Overage spend by model · {data.period.label}</h2>
          <Panel>
            {spendData.byModel.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted">No Cursor overage in {data.period.label}.</div>
            ) : (
              <ul className="space-y-1.5">
                {spendData.byModel.map((m) => (
                  <li key={m.model} className="flex items-center gap-3 text-sm">
                    <span className="w-48 shrink-0 truncate font-mono text-xs text-muted">{m.model}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${spendData.overage > 0 ? (m.cost / spendData.overage) * 100 : 0}%`,
                          background: VENDOR_COLORS.cursor,
                        }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right tabular-nums">{formatUsd(m.cost)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">Spend by person · {data.period.label}</h2>
          <Panel>
            {spendData.byPerson.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted">No Cursor spend in {data.period.label}.</div>
            ) : (
              <ul className="space-y-1.5">
                {spendData.byPerson.map((p) => (
                  <li key={p.name} className="flex items-center gap-3 text-sm">
                    <span className="w-48 shrink-0 truncate">{p.name}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${spendData.total > 0 ? (p.cost / spendData.total) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right tabular-nums">{formatUsd(p.cost)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>
      </div>
```

- [x] **Step 3: Lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean.

- [x] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/cursor-models/page.tsx" src/components/cursor-models/teams-model-view.tsx
git commit -m "feat: spend tiles, overage-by-model and spend-by-person on Cursor Usage"
```

---

### Task 5: Changelog entry + full verification

**Files:**
- Modify: `src/lib/changelog.ts` (prepend an entry — CLAUDE.md convention)

**Interfaces:**
- Consumes: `ChangelogEntry` shape from `src/lib/changelog.ts` (Task-independent).

- [x] **Step 1: Add the changelog entry**

In `src/lib/changelog.ts`, the 2026-07-07 entry already exists at the top of `CHANGELOG`. Append two items to that entry's `items` array (same-day release; don't add a duplicate date entry):

```ts
      "API Platforms now shows spend per vendor (click a vendor tile to filter) and spend per person.",
      "Cursor Usage now shows spend: totals for the period, overage by model, and spend per person.",
```

- [x] **Step 2: Full test suite and production build**

Run: `npm run test`
Expected: all pass (117 existing + 8 new = 125).

Run: `CI=true npm run build`
Expected: build succeeds.

- [x] **Step 3: Commit**

```bash
git add src/lib/changelog.ts
git commit -m "docs: changelog entries for vendor spend filter + Cursor spend"
```

- [x] **Step 4: Report**

Summarize; merging/deploying happens only on user request (repo rule).
