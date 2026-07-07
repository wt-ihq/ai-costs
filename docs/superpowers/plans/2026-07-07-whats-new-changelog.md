# What's New Changelog Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sparkle icon in the dashboard's top status bar that glows while there are unseen release notes and opens a popover of plain-language changelog entries.

**Architecture:** Content is a hand-curated array in `src/lib/changelog.ts` (ships with the deploy — no DB, no API). A pure `hasUnseen(latestDate, lastSeen)` helper decides the glow; seen-state is the newest entry's date in `localStorage`, computed in a `useEffect` so SSR and the client's first render match. The popover is a client component following the existing `search-box.tsx` conventions (outside-click close, Escape, theme tokens).

**Tech Stack:** Next.js 16 App Router, React client component, Tailwind v4 (`@theme` tokens in `src/app/globals.css`), `lucide-react` (already in package.json, currently unused), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-changelog-whats-new-design.md`

## Global Constraints

- Dark-first theme: use existing tokens (`border`, `surface`, `surface-2`, `foreground`, `muted`, `accent` = `#6ea8fe`) — no hard-coded colors in components.
- Changelog entries are plain English for dashboard users — features and fixes only, no engineering jargon.
- `localStorage` key is exactly `ai-costs:changelog-seen`; all access wrapped in try/catch (failure degrades to "always glowing", never a crash).
- `CHANGELOG` is ordered newest-first; `date` is an ISO day (`YYYY-MM-DD`) and doubles as the entry's identity.
- Working branch: `whats-new-changelog`. Run `npm run test` before each commit; run `CI=true npm run build` before finishing.

---

### Task 1: Changelog data + unseen helper

**Files:**
- Create: `src/lib/changelog.ts`
- Test: `src/lib/changelog.test.ts`

**Interfaces:**
- Produces: `type ChangelogEntry = { date: string; title: string; items: string[] }`; `const CHANGELOG: ChangelogEntry[]` (newest first); `function hasUnseen(latestDate: string, lastSeen: string | null): boolean`. Task 2 imports all three names from `@/lib/changelog`.

- [x] **Step 1: Write the failing test**

Create `src/lib/changelog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CHANGELOG, hasUnseen } from "./changelog";

describe("hasUnseen", () => {
  it("is true for a first-time visitor (no stored date)", () => {
    expect(hasUnseen("2026-07-07", null)).toBe(true);
  });

  it("is true when an entry is newer than the last seen date", () => {
    expect(hasUnseen("2026-07-07", "2026-06-30")).toBe(true);
  });

  it("is false when the latest entry has been seen", () => {
    expect(hasUnseen("2026-07-07", "2026-07-07")).toBe(false);
  });

  it("is false when the stored date is somehow newer", () => {
    expect(hasUnseen("2026-07-07", "2026-08-01")).toBe(false);
  });
});

describe("CHANGELOG", () => {
  it("has valid ISO dates and non-empty content", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    for (const entry of CHANGELOG) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.title.trim()).not.toBe("");
      expect(entry.items.length).toBeGreaterThan(0);
    }
  });

  it("is sorted newest-first", () => {
    const dates = CHANGELOG.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/changelog.test.ts`
Expected: FAIL — cannot resolve `./changelog`.

- [x] **Step 3: Write the implementation**

Create `src/lib/changelog.ts`:

```ts
/**
 * Hand-curated release notes for the "What's new" popover, newest first.
 * Entries are plain English for dashboard users — features and fixes only.
 * `date` (ISO day) doubles as the entry's identity for seen-tracking.
 */
export type ChangelogEntry = {
  date: string;
  title: string;
  items: string[];
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-07-07",
    title: "Sturdier syncs, safer sign-in — and this panel",
    items: [
      "Added this What's new panel — the sparkle glows when there's something you haven't seen.",
      "Pages now show a friendly error screen instead of crashing when something goes wrong.",
      "Fixed totals that could drop rows for teams with many people.",
      "Nightly data syncs now recover cleanly if a vendor API fails mid-run, and sign-in is locked down tighter.",
    ],
  },
  {
    date: "2026-06-30",
    title: "Better Cursor numbers & clearer charts",
    items: [
      "Cursor seat counts now come straight from the team roster, so idle seats are no longer missed.",
      "Ranked spend bars are color-coded by what the money went on (seats, overage, API).",
      "Employee data now comes from Okta, so team assignments stay in sync automatically.",
      "Data Health cross-checks our Cursor totals against Cursor's own numbers.",
    ],
  },
  {
    date: "2026-06-22",
    title: "Find anyone fast",
    items: [
      "New search box in the top bar — jump straight to any team or person.",
      "Month labels on trend charts no longer overlap on narrow screens.",
    ],
  },
];

/** True when the newest entry is newer than what this browser last saw. */
export function hasUnseen(latestDate: string, lastSeen: string | null): boolean {
  if (!lastSeen) return true;
  // ISO YYYY-MM-DD dates compare correctly as strings.
  return lastSeen < latestDate;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/changelog.test.ts`
Expected: PASS (6 tests).

- [x] **Step 5: Commit**

```bash
git add src/lib/changelog.ts src/lib/changelog.test.ts
git commit -m "feat: changelog data + hasUnseen helper for What's New panel"
```

---

### Task 2: WhatsNew popover component + glow animation

**Files:**
- Create: `src/components/whats-new.tsx`
- Modify: `src/app/globals.css` (add glow keyframes + `--animate-glow` token)

**Interfaces:**
- Consumes: `CHANGELOG`, `hasUnseen` from `@/lib/changelog` (Task 1); `cn` from `@/lib/utils`.
- Produces: `export function WhatsNew(): JSX.Element` — no props. Task 3 renders `<WhatsNew />` in the layout.

- [x] **Step 1: Add the glow animation to the theme**

In `src/app/globals.css`, inside the existing `@theme inline { ... }` block, add after `--font-mono: var(--font-geist-mono);`:

```css
  --animate-glow: glow 2.4s ease-in-out infinite;
```

And at the end of the file add:

```css
@keyframes glow {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(110, 168, 254, 0);
  }
  50% {
    box-shadow: 0 0 10px 2px rgba(110, 168, 254, 0.45);
  }
}
```

(Tailwind v4 turns `--animate-glow` into an `animate-glow` utility. The rgba is the `--accent` blue; keyframes can't reference theme vars portably across browsers for box-shadow, so the literal is acceptable here — noted exception to the no-hard-coded-colors constraint.)

- [x] **Step 2: Write the component**

Create `src/components/whats-new.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { CHANGELOG, hasUnseen } from "@/lib/changelog";
import { cn } from "@/lib/utils";

const SEEN_KEY = "ai-costs:changelog-seen";

// localStorage can throw (private-mode Safari, storage disabled). Failure
// degrades to "always glowing" — never a crash.
function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(date: string) {
  try {
    window.localStorage.setItem(SEEN_KEY, date);
  } catch {
    // Ignore: the glow will just persist in this browser.
  }
}

/** Status-bar "What's new" button; glows until the latest entry is seen. */
export function WhatsNew() {
  const [open, setOpen] = useState(false);
  // Server-rendered glowless; the effect below lights it up after mount
  // (localStorage is client-only — reading it during render would desync
  // hydration).
  const [glow, setGlow] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const latest = CHANGELOG[0]?.date;

  useEffect(() => {
    if (latest) setGlow(hasUnseen(latest, readSeen()));
  }, [latest]);

  // Close on outside click (same convention as explore/search-box.tsx).
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const toggle = () => {
    if (!open && latest) {
      writeSeen(latest);
      setGlow(false);
    }
    setOpen((o) => !o);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        aria-label="What's new"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-foreground",
          glow && "animate-glow text-accent",
        )}
      >
        <Sparkles className="h-4 w-4" aria-hidden />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Release notes"
          className="absolute right-0 z-50 mt-1 max-h-96 w-80 overflow-y-auto rounded-md border border-border bg-surface p-4 shadow-lg"
        >
          <div className="mb-3 text-sm font-semibold text-foreground">What&apos;s new</div>
          {CHANGELOG.length === 0 ? (
            <p className="text-sm text-muted">No release notes yet.</p>
          ) : (
            <ul className="space-y-4">
              {CHANGELOG.map((entry) => (
                <li key={entry.date}>
                  <div className="text-xs text-muted">{entry.date}</div>
                  <div className="text-sm font-medium text-foreground">{entry.title}</div>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-muted">
                    {entry.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 3: Verify it compiles and lints**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors in `whats-new.tsx` (pre-existing warnings elsewhere are fine).

- [x] **Step 4: Commit**

```bash
git add src/components/whats-new.tsx src/app/globals.css
git commit -m "feat: What's New popover component with unseen glow"
```

---

### Task 3: Mount in the status bar + maintenance note

**Files:**
- Modify: `src/app/(dashboard)/layout.tsx:37-40` (status bar right side)
- Modify: `CLAUDE.md` (Conventions & constraints section)

**Interfaces:**
- Consumes: `WhatsNew` from `@/components/whats-new` (Task 2).

- [x] **Step 1: Render the button in the layout**

In `src/app/(dashboard)/layout.tsx`, add the import:

```tsx
import { WhatsNew } from "@/components/whats-new";
```

and replace the signed-in `<span>`:

```tsx
          <span>{role ? `Signed in · ${role}` : "Not signed in"}</span>
```

with:

```tsx
          <div className="flex items-center gap-3">
            <WhatsNew />
            <span>{role ? `Signed in · ${role}` : "Not signed in"}</span>
          </div>
```

- [x] **Step 2: Add the maintenance convention to CLAUDE.md**

In `CLAUDE.md`, under `## Conventions & constraints`, add this bullet after the "New server actions" bullet:

```markdown
- When shipping user-visible changes, add a plain-language entry (features and fixes, no jargon) to `CHANGELOG` in `src/lib/changelog.ts`, newest first — it feeds the "What's new" popover.
```

- [x] **Step 3: Full test suite and production build**

Run: `npm run test`
Expected: all tests pass (110 existing + 6 new).

Run: `CI=true npm run build`
Expected: build succeeds.

- [x] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/layout.tsx" CLAUDE.md
git commit -m "feat: mount What's New in status bar; document changelog convention"
```

---

### Task 4: Verify in the running app

**Files:** none (verification only).

- [ ] **Step 1: Run the app and exercise the flow**

Run: `AUTH_DISABLED=true npm run dev` and open `http://localhost:3000/explore`.

Verify:
1. Sparkle icon appears in the top bar next to "Signed in / Not signed in", pulsing with a soft blue glow.
2. Clicking it opens the panel: three dated entries, plain-language bullets, panel scrolls if needed.
3. Glow stops once opened; reloading the page keeps it off (localStorage `ai-costs:changelog-seen` = `2026-07-07`).
4. In DevTools, delete the localStorage key and reload — the glow returns.
5. Outside click and Escape both close the panel.

(If `AUTH_DISABLED` requires env not present, create `.env.local` with `AUTH_DISABLED=true` — dev-only bypass, gitignored.)

- [ ] **Step 2: Report results**

No commit — report the checklist outcomes (screenshots if running with browser tooling).
