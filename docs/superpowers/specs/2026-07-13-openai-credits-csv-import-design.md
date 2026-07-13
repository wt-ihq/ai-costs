# OpenAI Credit-Usage CSV Import

**Date:** 2026-07-13
**Status:** Approved design

## Problem

ChatGPT Business overage is currently captured by pasting the Workspace-analytics
member table: month grain, display names only (fuzzy-matched), no model split, and
its "Credits spent" column mixes bundled seat credits (already paid for) with
additional paid credits — so bundled usage gets misbooked as paid overage.

OpenAI's admin console exports a **Credit Usage Report** CSV (e.g.
`analytics/Intent HQ Credit Usage Report (Jul 13, 2025 - Jul 13, 2026).csv`) that
covers only the **additional (paid) credit pool** at a much finer grain: one row
per `day × user × usage_type`, with real emails and token/message quantities.

CSV columns:
`date_partition, account_id, account_user_id, email, name, public_id, usage_type, usage_credits, usage_quantity, usage_units`

`usage_type` families observed:

| Family | Examples | `usage_units` |
|---|---|---|
| API / Codex tokens | `api.codex_fast_gpt_5_5_2026_04_23_text_cached_input_v_1`, `api.gpt_5_5_2026_04_23_text_output_v_1` | `tokens` |
| ChatGPT messages | `chat.completion.5.pro`, `chat.completion.4.5`, `chat_agent.completion` | `counts` |
| Codex tasks | `codex`, `codex.local.2` | `counts` |

## Decisions (agreed with Gareth)

1. The CSV **replaces the paste import as the source of overage** — it is the same
   paid-credit spend, but honest (additional credits only) and finer-grained.
2. The **paste import stays for seats only**: it keeps writing the $25/mo seat
   facts for every member; its credits column is ignored (no more overage facts
   from the paste).
3. Import is **manual, monthly-ish**: admin downloads the CSV from the OpenAI
   admin console and uploads it on the Imports page.
4. The **USD-per-credit rate is set at import time** via an input field,
   prefilled from the last-used rate (persisted), applied at preview.
5. Presentation = **Explore + model split**: no new pages; daily-grain facts with
   clean model labels light up the existing drill-down, trend charts, and model
   breakdowns.

## Design

### Parser — `src/lib/ingest/parsers/openai-credits.ts`

- Parse the 10-column CSV. Tolerate a UTF-8 BOM. Validate the header row; a
  missing/renamed required column (`date_partition`, `email`, `usage_type`,
  `usage_credits`, `usage_quantity`, `usage_units`) fails the whole parse with a
  clear error (schema-drift stance, matching the normalizers).
- Per-row errors (bad date, non-numeric credits) are collected as
  `ParseRowError`s and surfaced in the preview; good rows still import.
- **`usage_type` → model label** mapping:
  - `api.<model>_text_(cached_)input/output/cache_write_input_v_1` → strip the
    token-kind suffix and version, humanize the model stem, e.g.
    `api.codex_fast_gpt_5_5_2026_04_23_text_input_v_1` → `GPT-5.5 Codex (fast)`;
    `api.gpt_5_4_mini_2026_03_17_…` → `GPT-5.4 mini`.
  - `chat.completion.<v>` → `GPT-<v> (chat)` (e.g. `GPT-5 Pro (chat)`).
  - `chat_agent.completion` → `ChatGPT Agent`.
  - `codex` → `Codex tasks`; `codex.local.2` → `Codex (local)`.
  - Unknown types degrade to a readable label derived from the raw string
    (never dropped, never thrown).
- **Aggregate** rows per `(email, day, model)` into one prospective fact:
  - `credits = Σ usage_credits` (input + cached-input + output line items merge)
  - `tokens = Σ usage_quantity` where `usage_units = tokens`
  - `requests = Σ usage_quantity` where `usage_units = counts`
- The parser returns credits (not USD); the action applies the rate, so the
  parser stays pure and rate-agnostic.

### Import action — `src/app/(dashboard)/imports/actions.ts`

`previewOpenAiCreditsImport(csv, usdPerCredit)` / `commitOpenAiCreditsImport(...)`,
both starting with `await requireAdmin()`.

- **Preview:** parse + aggregate, exact-email match against `employees`
  (lowercased), compute `costUsd = round(credits × rate, 2)` per fact, and return:
  totals (credits, USD), covered date range, per-user rollup sorted by spend,
  unmatched emails, and parse errors. No fuzzy matching needed — emails are exact.
- **Commit:** window-replace of the overage slice only:
  - Reject an empty preview (gotcha #4).
  - Window = `[first day's month start, last day + 1)`, exclusive-end. Month-start
    lower bound sweeps out old month-stamped paste overage (stamped `YYYY-MM-01`)
    for covered months.
  - Upsert-before-prune via the `replaceWindowFacts` pattern, **scoped to
    `source = chatgpt_business` AND `cost_type = 'overage'`** — seat facts are
    untouched. (`replaceWindowFacts` gains an optional cost-type scope if it
    doesn't have one.)
  - Facts: `source: "chatgpt_business"`, `costType: "overage"`,
    `entityKey: email`, daily `day`, `model`, `costUsd`, `tokens`, `requests`,
    `employeeId` from the email match.
  - Upsert `identities` (`vendor: chatgpt_business`, `external_email`,
    `match_method: exact_email`) for matched users.
  - Log an `imports` row (`source: chatgpt_business`, `kind: "csv"`) with row
    counts and the covered range so the coverage table reflects it.
- **Rate persistence:** record `usd_per_credit` inside the `imports` log row's
  JSON counts/metadata on commit; the page prefills the rate input from the most
  recent credits-import row (fallback `0.04` — the admin billing page's Credits
  balance card showed 11,732 credits = $469.26, i.e. $0.04/credit, on
  2026-07-13). No new table or migration. The balance card is also the
  sanity-check for the rate at each import.

### Paste import change

`commitChatGptImport` stops writing overage facts and stops deleting them:
- Its month-snapshot delete narrows to `cost_type = 'seat'` (mirroring the
  Claude roster commit) so it can never clobber CSV-imported overage.
- The preview UI keeps showing the credits column read-only for eyeballing, but
  labels it as not imported.

### Imports page UI

A new card next to the existing ones: file input (or paste of CSV text — same
parser), an **editable USD-per-credit field** (prefilled from the last import's
rate, but freely changeable on every import — editing it re-prices the preview
before commit), preview table (per-user credits, USD, match status, covered
date range, model count), commit button. Mirrors the Claude roster CSV card's
structure. Plus:

- **Imported-through indicator:** the card shows the last day of previously
  imported credits data — `max(day)` of existing `chatgpt_business` overage
  facts (server-fetched with the page, alongside the coverage data) — e.g.
  "Data imported through 11 Jul 2026", or "No credits data imported yet". This
  tells the admin whether a fresh export is needed and what the new one must
  cover.
- **Source instructions:** helper text on the card pointing at where the export
  lives: [chatgpt.com/admin/billing](https://chatgpt.com/admin/billing) →
  **Credits balance** section → **⋮ → Download usage data** (the menu shows the
  report's "Updated" date — data lags a day or two, so today's usage won't be in
  it).

### Presentation

No new pages. Effects of daily-grain, email-keyed, model-labelled facts:
- Explore Company/Team/Person pick up ChatGPT Business daily trends automatically.
- Model breakdowns show the Codex-vs-chat split (in the current file ~85% of
  credits are Codex, and monthly burn rose from ~3K to ~50K credits since
  April 2026).
- Import-coverage table on the Imports page gains the credits import's months.

### Out of scope

- No automated fetch (no public API for this report today).
- No dedicated credits-analytics page (revisit if the model split in Explore
  proves insufficient).
- No cache-hit-rate metrics (would need cached-vs-uncached kept separate;
  aggregation folds them together — acceptable for spend tracking).
- Historical paste-imported overage outside the CSV's covered window is left
  as-is.

## Testing

- **Parser fixtures** (`openai-credits.test.ts`): real header + representative
  rows — token triplets that merge into one fact, `chat.completion.5.pro`
  counts, codex tasks, unknown `usage_type` (degrades, not dropped), BOM
  handling, bad rows → `ParseRowError`, header drift → hard failure.
- **Label mapping table test** for every family above.
- **Commit-scope test**: replacing a window deletes only `overage` facts for
  `chatgpt_business`; seat facts in the same window survive.
- **Paste-commit regression**: paste import writes seats only and its delete no
  longer touches overage.
- `npm run test` and `CI=true npm run build` before committing.

## Rollout

1. Ship parser + actions + UI behind nothing (admin-only page already).
2. Import the full-year CSV once — it replaces historical paste overage for
   covered months in one shot.
3. Monthly routine: paste member table (seats) + upload fresh CSV (overage).
   Re-uploading overlapping exports is always safe (window replace).
4. Changelog entry in `src/lib/changelog.ts` (plain language).
