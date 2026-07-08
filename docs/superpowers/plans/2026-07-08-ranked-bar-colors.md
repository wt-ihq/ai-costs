# Ranked Bar Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ranked-list rows show a thin full-saturation segmented bar (exact chart colors) instead of an opacity-30 tinted background.

**Architecture:** Single-component change in `ranked-list.tsx`: delete `SplitBar`, restructure `Row` to text line + thin track/fill beneath, using `dimColor` at full saturation with 2px segment gaps.

**Tech Stack:** React, Tailwind, motion.

**Spec:** `docs/superpowers/specs/2026-07-08-ranked-bar-colors-design.md`

## Global Constraints

- Segment colors are `dimColor(dim, key)` untouched — no opacity on them.
- 2px gaps between segments (`gap-0.5`); rounded ends; track `h-1.5 bg-surface-2`.
- Row hover/link/motion/props unchanged.
- Working branch: `ranked-bar-colors`. `npm run test` + `CI=true npm run build` before finishing.

---

### Task 1: Restyle Row

**Files:**
- Modify: `src/components/explore/ranked-list.tsx`
- Modify: `src/lib/changelog.ts` (append item to the 2026-07-08 entry)

- [x] **Step 1: Replace SplitBar + Row**

In `src/components/explore/ranked-list.tsx`, delete the `SplitBar` function and replace `Row` with:

```tsx
function Row({ r, max, i, dim, linkQuery }: { r: RankRow; max: number; i: number; dim: Dim; linkQuery?: string }) {
  const reduce = useReducedMotion();
  const pct = max > 0 ? (r.total / max) * 100 : 0;
  const segs = r.segments?.[dim] ?? [];
  const body = (
    <motion.div
      initial={reduce ? false : { opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.15, delay: Math.min(i, 20) * 0.015 }}
      className={cn("group rounded-lg border border-border/60 bg-surface px-4 py-3 transition-colors", r.href && "hover:border-accent/60 hover:bg-surface-2")}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {r.label}
            {r.idle && <span className="ml-2 rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-pink-300">idle seat</span>}
          </div>
          {r.sub && <div className="truncate text-xs text-muted">{r.sub}</div>}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold tabular-nums">{formatUsd(r.total)}</div>
          {r.perHead != null && <div className="text-xs text-muted">{formatUsd(r.perHead)}/head</div>}
        </div>
      </div>
      {/* Thin full-saturation split bar — same colors as the charts. */}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
        {r.total > 0 && (segs.length > 0 ? (
          <div className="flex h-full gap-0.5" style={{ width: `${pct}%` }}>
            {segs.map((s) => (
              <div key={s.key} className="h-full rounded-full" style={{ width: `${(s.value / r.total) * 100}%`, background: dimColor(dim, s.key) }} />
            ))}
          </div>
        ) : (
          <div className="h-full rounded-full bg-accent/40" style={{ width: `${pct}%` }} />
        ))}
      </div>
    </motion.div>
  );
  const href = r.href && linkQuery ? `${r.href}?${linkQuery}` : r.href;
  return href ? <Link href={href} className="block">{body}</Link> : body;
}
```

- [x] **Step 2: Changelog item**

In `src/lib/changelog.ts`, append to the `2026-07-08` entry's `items`:

```ts
      "Department and people bars now use the exact same colors as the charts.",
```

- [x] **Step 3: Verify and commit**

Run: `npm run lint && npx tsc --noEmit && npm run test` — clean, 131 pass.
Run: `CI=true npm run build` — succeeds.

```bash
git add src/components/explore/ranked-list.tsx src/lib/changelog.ts
git commit -m "fix: ranked-list bars use full-saturation chart colors"
```
