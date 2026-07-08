# Explore Filter Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Explore filter bar from shifting when a vendor is selected — dedicated filter row, toggle dims in place instead of unmounting.

**Architecture:** Layout-only change inside `ExploreView`: split the single header row into a period row and a filter row, and give `Toggle` a `disabled` prop instead of conditionally rendering it.

**Tech Stack:** React, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-08-explore-filter-row-design.md`

## Global Constraints

- Nothing in the control area may appear/disappear/move on filter change.
- Working branch: `explore-filter-row`. `npm run test` + `CI=true npm run build` before finishing.

---

### Task 1: Restructure the control rows + disable-in-place toggle

**Files:**
- Modify: `src/components/explore/explore-view.tsx`

**Interfaces:**
- `Toggle({ dim, onChange, disabled }: { dim: Dim; onChange: (d: Dim) => void; disabled?: boolean })` — internal to the file.

- [x] **Step 1: Update Toggle**

Replace the `Toggle` function with:

```tsx
function Toggle({ dim, onChange, disabled }: { dim: Dim; onChange: (d: Dim) => void; disabled?: boolean }) {
  return (
    <div
      className={cn("inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs", disabled && "opacity-60")}
      title={disabled ? "Charts split by cost type while a vendor filter is active" : undefined}
    >
      {(["vendor", "cost_type"] as Dim[]).map((d) => (
        <button
          key={d}
          disabled={disabled}
          onClick={() => { onChange(d); syncParam("dim", d); }}
          className={cn("rounded px-2.5 py-1 transition-colors", dim === d ? "bg-accent/20 text-accent" : "text-muted", !disabled && dim !== d && "hover:text-foreground")}
        >
          {d === "vendor" ? "By vendor" : "By cost type"}
        </button>
      ))}
    </div>
  );
}
```

- [x] **Step 2: Split the header into two rows**

In `ExploreView`'s JSX, replace:

```tsx
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PeriodControl period={period} earliest={scope.earliest} onChange={changePeriod} />
        <div className="flex flex-wrap items-center gap-3">
          <VendorChips vendors={vendors} active={vendor} onChange={changeVendor} />
          {vendor === "all" && <Toggle dim={dim} onChange={setDim} />}
        </div>
      </div>
```

with:

```tsx
      <PeriodControl period={period} earliest={scope.earliest} onChange={changePeriod} />

      {/* Filter row: fixed composition — the toggle dims instead of unmounting,
          so nothing shifts when a vendor is (de)selected. */}
      <div className="flex flex-wrap items-center gap-4">
        <VendorChips vendors={vendors} active={vendor} onChange={changeVendor} />
        <div className="ml-auto">
          <Toggle dim={effectiveDim} onChange={setDim} disabled={vendor !== "all"} />
        </div>
      </div>
```

(`ml-auto` instead of `justify-between` keeps the toggle right-aligned even on
scopes where `VendorChips` renders nothing — single-vendor person pages.)

(Note: `space-y-6` on the wrapper gives more air between the rows than the old
single row had — acceptable; keep the outer structure otherwise unchanged.)

- [x] **Step 3: Verify and commit**

Run: `npm run lint && npx tsc --noEmit && npm run test`
Expected: clean; 131 tests pass.

Run: `CI=true npm run build`
Expected: build succeeds.

```bash
git add src/components/explore/explore-view.tsx
git commit -m "fix: stable Explore filter row — toggle dims in place, chips never shift"
```
