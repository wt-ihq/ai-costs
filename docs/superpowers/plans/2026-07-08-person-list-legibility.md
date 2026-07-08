# Person-List Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the day count that drives the Cursor "By person" ordering, and truncate the three long person lists to 10 rows with a "Show all" toggle.

**Architecture:** One tiny shared client component (`ShowAllList`) owns the truncate/expand behavior; the three panels pass their existing `<li>` rows through its `render` prop. The day count already exists on `TopModelPerson.days` — view-only change, no shaper edits.

**Tech Stack:** React client components, Tailwind, Vitest (SSR smoke test via `react-dom/server`, as in `whats-new.test.ts`).

**Spec:** `docs/superpowers/specs/2026-07-08-person-list-legibility-design.md`

## Global Constraints

- Truncation limit is 10; button copy is exactly "Show all {n}" / "Show fewer"; no animation, no persistence.
- Sort orders unchanged everywhere.
- Empty lists keep their existing empty-state markup (ShowAllList only renders when items exist).
- Working branch: `person-list-legibility`. `npm run test` before each commit; `CI=true npm run build` before finishing.

---

### Task 1: `ShowAllList` component

**Files:**
- Create: `src/components/show-all-list.tsx`
- Test: `src/components/show-all-list.test.ts` (SSR smoke — vitest only picks up `.ts`, so no JSX; use `createElement`)

**Interfaces:**
- Produces: `function ShowAllList<T>({ items, limit = 10, render }: { items: T[]; limit?: number; render: (item: T) => React.ReactNode })` — `render` must return a keyed `<li>`. Tasks 2–3 import it from `@/components/show-all-list`.

- [x] **Step 1: Write the failing test**

Create `src/components/show-all-list.test.ts`:

```ts
// SSR smoke test: collapsed state renders `limit` rows + the toggle;
// short lists render fully with no toggle.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShowAllList } from "./show-all-list";

const items = (n: number) => Array.from({ length: n }, (_, i) => `item-${i}`);
const renderItem = (s: string) => createElement("li", { key: s }, s);

describe("ShowAllList (SSR)", () => {
  it("renders only the first `limit` items plus a Show all toggle", () => {
    const html = renderToStaticMarkup(
      createElement(ShowAllList<string>, { items: items(12), limit: 10, render: renderItem }),
    );
    expect(html.match(/<li>/g)).toHaveLength(10);
    expect(html).toContain("Show all 12");
  });

  it("renders short lists fully with no toggle", () => {
    const html = renderToStaticMarkup(
      createElement(ShowAllList<string>, { items: items(5), limit: 10, render: renderItem }),
    );
    expect(html.match(/<li>/g)).toHaveLength(5);
    expect(html).not.toContain("Show all");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/show-all-list.test.ts`
Expected: FAIL — cannot resolve `./show-all-list`.

- [x] **Step 3: Write the component**

Create `src/components/show-all-list.tsx`:

```tsx
"use client";

import { useState } from "react";

/**
 * A list that renders the first `limit` items with a quiet "Show all n" /
 * "Show fewer" toggle. `render` must return a keyed <li>.
 */
export function ShowAllList<T>({
  items,
  limit = 10,
  render,
}: {
  items: T[];
  limit?: number;
  render: (item: T) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, limit);
  return (
    <div>
      <ul className="space-y-1.5">{visible.map(render)}</ul>
      {items.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-3 text-xs text-muted transition-colors hover:text-foreground"
        >
          {expanded ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/show-all-list.test.ts`
Expected: PASS (2 tests).

- [x] **Step 5: Commit**

```bash
git add src/components/show-all-list.tsx src/components/show-all-list.test.ts
git commit -m "feat: ShowAllList — truncated list with Show all toggle"
```

---

### Task 2: Cursor Usage — day counts + truncation

**Files:**
- Modify: `src/components/cursor-models/teams-model-view.tsx` ("By person" and "Spend by person" panels)

**Interfaces:**
- Consumes: `ShowAllList` (Task 1); existing `TopModelPerson.days` (already on the type), `modelColor`, `formatUsd`.

- [x] **Step 1: Add the import**

```tsx
import { ShowAllList } from "@/components/show-all-list";
```

- [x] **Step 2: Rework the "By person" rows**

Replace the `<ul className="space-y-1.5">…</ul>` inside the "By person" panel (currently mapping `data.people`) with:

```tsx
              <ShowAllList
                items={data.people}
                render={(p) => (
                  <li key={p.id} className="flex items-center gap-3 text-sm">
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0 text-xs text-muted" title="Days with Cursor usage in this period">
                      {p.days}d
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      <span className="size-2.5 rounded-full" style={{ background: modelColor(p.primaryModel) }} />
                      <span className="font-mono text-xs text-muted">{p.primaryModel}</span>
                    </span>
                  </li>
                )}
              />
```

(The surrounding `data.people.length === 0 ? <empty state> : (…)` conditional stays.)

- [x] **Step 3: Truncate "Spend by person"**

In the same file's "Spend by person" panel, replace the `<ul className="space-y-1.5">…</ul>` (mapping `spendData.byPerson`) with:

```tsx
              <ShowAllList
                items={spendData.byPerson}
                render={(p) => (
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
                )}
              />
```

- [x] **Step 4: Lint, typecheck, commit**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean.

```bash
git add src/components/cursor-models/teams-model-view.tsx
git commit -m "feat: day counts + top-10 truncation on Cursor Usage person lists"
```

---

### Task 3: API Platforms truncation + changelog + verify

**Files:**
- Modify: `src/components/api-platforms/api-platforms-view.tsx` ("Spend by person" panel)
- Modify: `src/lib/changelog.ts` (new dated entry)

**Interfaces:**
- Consumes: `ShowAllList` (Task 1); existing `formatUsd`.

- [x] **Step 1: Truncate the API "Spend by person" panel**

Add the import:

```tsx
import { ShowAllList } from "@/components/show-all-list";
```

Replace the `<ul className="space-y-1.5">…</ul>` mapping `people` with:

```tsx
            <ShowAllList
              items={people}
              render={(p) => (
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
              )}
            />
```

- [x] **Step 2: Add the changelog entry**

In `src/lib/changelog.ts`, prepend a new entry to `CHANGELOG` (new date — yesterday's entry stays):

```ts
  {
    date: "2026-07-08",
    title: "Tidier people lists",
    items: [
      "The Cursor 'By person' list now shows each person's active-day count — that's what the list is sorted by.",
      "Long people lists show the top 10 with a 'Show all' toggle.",
    ],
  },
```

- [x] **Step 3: Full test suite and production build**

Run: `npm run test`
Expected: all pass (125 existing + 2 new = 127).

Run: `CI=true npm run build`
Expected: build succeeds.

- [x] **Step 4: Commit**

```bash
git add src/components/api-platforms/api-platforms-view.tsx src/lib/changelog.ts
git commit -m "feat: truncate API spend-by-person list; changelog entry"
```
