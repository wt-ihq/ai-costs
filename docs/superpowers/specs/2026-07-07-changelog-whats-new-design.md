# What's New changelog — design

**Date:** 2026-07-07
**Status:** Approved (option A — status-bar popover)

## Purpose

Give dashboard users a lightweight way to see what changed in the app, in plain
language (new features and fixes only — no engineering jargon). A glowing icon
signals unseen entries; the glow clears once the user opens the panel.

## Design

### Content: `src/lib/changelog.ts`

A hand-curated, checked-in array — newest first:

```ts
export type ChangelogEntry = {
  date: string; // ISO day, e.g. "2026-07-07" — also the entry's identity
  title: string; // short release name, e.g. "Sturdier syncs & sign-in fixes"
  items: string[]; // plain-English bullets: features and fixes
};
export const CHANGELOG: ChangelogEntry[] = [ ... ];
```

- Entries are written by hand in simple language aimed at dashboard users
  ("You can now search for a person from any page"), not commit messages.
- Ships with the deploy: no API calls, no DB, no auth surface.
- Seeded with entries for the recent `review-fixes` release and earlier
  milestones (initial dashboard, Okta identity spine, Cursor/OpenAI/Anthropic
  sources).

### Unseen logic: pure helper in `src/lib/changelog.ts`

`hasUnseen(latestDate: string, lastSeen: string | null): boolean` — true when
`lastSeen` is null or lexicographically `< latestDate` (ISO dates compare
correctly as strings). Unit-tested.

### UI: `src/components/whats-new.tsx` (client component)

- A small sparkle icon button rendered in the dashboard layout's top status
  bar, next to the "Signed in · role" text.
- **Glow:** when `hasUnseen(...)` is true, the icon gets a soft pulsing glow
  (Tailwind animation + colored shadow). To avoid hydration mismatch the
  glow state is computed in a `useEffect` (localStorage is client-only);
  the icon renders glowless on the server and lights up after mount.
- **Popover:** clicking toggles a right-aligned dropdown panel listing each
  entry: date, title, bullet list. Scrollable past ~4 entries.
  Closes on outside click and Escape (same conventions as `search-box.tsx`).
- **Seen-state:** on open, write the newest entry's `date` to
  `localStorage["ai-costs:changelog-seen"]` and stop glowing. Per-browser by
  design — no server round-trip, acceptable for an internal tool.

### Maintenance

CLAUDE.md gains one line: when shipping user-visible changes, add a
`CHANGELOG` entry in `src/lib/changelog.ts` in plain language.

## Error handling

- `localStorage` access wrapped in try/catch (private-mode Safari etc.) —
  failure degrades to "always glowing", never a crash.
- Empty `CHANGELOG` renders the button without glow and an empty-state line
  in the panel.

## Testing

- `src/lib/changelog.test.ts`: `hasUnseen` cases (null, older, equal, newer)
  plus a sanity check that `CHANGELOG` is sorted newest-first with valid ISO
  dates.
- UI verified by running the app (no component-test framework in this repo).

## Out of scope

- Per-user server-side read state, RSS/email digests, auto-generation from
  git history, admin editing UI.
