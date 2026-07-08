# ChatGPT import guardrails + import-coverage view — design

**Date:** 2026-07-08
**Status:** Approved

## Purpose

Manual imports can double-count when the ChatGPT dashboard's rolling windows
(1M/6M/12M) are used instead of calendar months, and an empty commit can blank
a month. Make the calendar-month protocol explicit in the UI, refuse empty
commits, and show which months have data so gaps/mistakes are visible.

## Part A — guardrails

- **Copy** (`imports/page.tsx` panel text + `chatgpt-import.tsx`):
  - Panel text gains the rule: "Export a **Custom** range covering exactly one
    calendar month — the 1M preset is a rolling 30-day window and
    double-counts across months."
  - The "Data as of" label becomes "Month" (input unchanged; only the month is
    used).
- **Empty-commit guard** (`imports/actions.ts`): `commitChatGptImport` and
  `commitClaudeRoster` throw `"Nothing to import — the preview has no rows."`
  *before* their month-delete (gotcha #4: never delete when the insert would
  be empty). `commitClaudeSpendImport` doesn't delete, so no guard needed.

## Part B — import coverage view

- **Query** `src/lib/queries/import-coverage.ts`:
  `getImportCoverageScope(supabase)` reads (paginated, `.order("day").order("id")`):
  - `spend_facts` for `source in (chatgpt_business, claude_team)`, columns
    `day, source, cost_type, cost_usd`;
  - `imports` log, columns `source, kind, data_as_of, created_at, status`
    (ordered by `created_at`, paginated).
  Returns `{ facts, imports }` raw rows.
- **Shaper** `src/lib/queries/import-coverage.ts:buildImportCoverage(facts, imports, nowMonth)` (pure, exported for tests):
  - Months from earliest fact month → `nowMonth`, newest first; empty when no
    facts.
  - Per month, three cells: `chatgpt` (chatgpt_business seat+overage sum),
    `claudeSpend` (claude_team overage sum), `claudeSeats` (claude_team seat
    sum) — each `{ totalUsd, lastImport: string | null }` or `null` when no
    facts. `lastImport` = latest successful `imports.created_at` (as ISO day)
    whose `data_as_of` falls in that month, matched per column: chatgpt →
    `source=chatgpt_business`; claudeSpend → `claude_team` + `kind=clipboard`;
    claudeSeats → `claude_team` + `kind=csv`.
- **UI** `src/components/import-coverage.tsx` (server component): "Import
  coverage" table — Month | ChatGPT Business | Claude spend | Claude seats;
  cell = `$total` with muted `imported <day>` beneath (or just the total when
  no matching log row); `—` muted when null. Rendered in a new Panel at the
  top of the Imports page grid.
- Changelog item appended to the 2026-07-08 entry.

## Error handling

- No facts at all → panel shows "No manual imports yet."
- Failed imports (status ≠ success) are ignored for `lastImport`.

## Testing

- Unit tests for `buildImportCoverage` (month range fill, per-column sums,
  kind-based lastImport mapping, ignores failed imports, empty input).
- Full suite + `CI=true` build; prod eyeball after merge.

## Out of scope

- Parsing/validating the pasted window (the paste has no dates); auto-synced
  sources in the coverage table; editing/deleting past imports.
