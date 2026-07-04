# CLAUDE.md

Internal dashboard for Intent HQ that tracks AI-tool spend (Anthropic, OpenAI, Cursor) by company → team → person, attributing usage to employees via Okta.

## Commands

```bash
npm run dev          # local dev server
npm run build        # production build (run before deploying; CI=true to silence prompts)
npm run lint         # eslint
npm run test         # vitest run (all tests)
npm run test:watch   # vitest watch
```

Always run `npm run test` and `CI=true npm run build` before committing ingest/query changes.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Supabase (Postgres) · Auth.js v5 (Google SSO) · Recharts · Motion. Deployed on Vercel; daily cron at 06:00 UTC.

## Architecture

- **`src/app/(dashboard)/explore/`** — the dashboard: Company → Team (`[team]`) → Person (`[team]/[person]`) drill-down. Server components read via `src/lib/queries/`.
- **`src/lib/queries/`** — read layer. `common.ts:fetchFactsInRange` is the main fact reader; `explore.ts`, `data-health.ts`, `api-platforms.ts` build page data.
- **`src/lib/explore/`** — pure shapers (`shape.ts`) + types for the explore views. Unit-tested.
- **`src/lib/ingest/`** — the write pipeline:
  - `sources/` — live API fetchers (injectable for tests).
  - `normalizers/` — vendor payload → `SpendFact[]`. Fixture-tested; throw `SchemaDriftError` on unexpected shapes.
  - `run-*.ts` — per-source orchestrators; `run-all.ts:runAllSyncs` runs them source-isolated.
  - `persist.ts` — employee resolution + `upsertSpendFacts` + `replaceWindowFacts` (snapshot-replace: upsert first, then prune stale keys — never delete-then-insert).
  - `pricing.ts` — Anthropic token list-price table.
- **`src/app/api/cron/sync/route.ts`** — the sync endpoint (CRON_SECRET-gated, fails closed if the secret is unset). `?from=&to=` overrides the window for backfill; `?source=cursor` (comma-separated) runs a single source. **All sync/delete windows are exclusive-end** (`[startDate, endDate)`), matching the vendor APIs.
- **Auth**: `src/proxy.ts` (edge gate) + `(dashboard)/layout.tsx` (page gate) + `src/lib/auth-guard.ts:requireAdmin` — **every `"use server"` action must call `requireAdmin()` first** (actions are public POST endpoints; the layout gate does not run for them). `AUTH_DISABLED=true` only works with `NODE_ENV=development`.

## Data model

Single `spend_facts` table. Unique key: **`(source, day, cost_type, entity_key, model)`** — `upsertSpendFacts` upserts on this.
- `cost_type`: `seat` | `overage` | `metered`. **`metered` is labelled "API"** in the UI (`COST_TYPE_LABEL` in `src/lib/types.ts`). `overage` = usage-based spend beyond the plan.
- Idempotent: re-running a window upserts the same keys. Metered/snapshot syncs go through `replaceWindowFacts` — no-op on an empty snapshot (a transient empty API response can't wipe a month), and upsert-before-prune so a crash mid-sync leaves stale rows (healed next run) rather than a blank window.
- Employees (from Okta) are the identity spine; facts attribute via `entity_key` (email or owner) → `employee_id`. Roster pages show all employees/departments ($0 if no spend).

## Source-specific notes

- **Anthropic** — hybrid: the **Cost Report API is the authoritative daily total** (its `amount` is in **CENTS** — ÷100; the earlier "~1000× too high" scare was this unit misread, fixed in 38df7bd), and Usage-report tokens priced at list rates (`pricing.ts` → `priceUsageResult`, scaled per day via `estimateAndScale`) provide the per-key/per-model split. Exact total, estimated allocation. Keep the list-price table current — a stale table skews the split even though day totals stay exact. Per-key → creator (`created_by` user → email → employee). Days with cost but no usage rows land as an `unkeyed` fact. **Periodically eyeball totals against Claude's own dashboard** (gotcha #2).
- **Cursor** (Teams plan) — three Admin API endpoints: `teams/members` → authoritative seat roster → one $40 `seat` fact per non-removed member, **current month only** (the roster is date-less, so it's gated to the window's current month; historical months fall back to usage-derived seats); `daily-usage-data` → active-user $40/seat facts (covers historical months); `filtered-usage-events` → per-event `chargedCents` (`> 0`) aggregated into `overage` facts per (email, day, model). Events self-date, so backfill in 28-day windows (under Cursor's 30-day cap). Fetchers retry 429/5xx with backoff. (Model-usage/MCP analytics require the **Enterprise** plan — gated off via `CURSOR_ANALYTICS_ENABLED`.)
- **OpenAI** — costs endpoint; attributed via project owners.
- **Okta** (identity spine) — `GET /api/v1/users?search=status pr` (all statuses incl. DEPROVISIONED leavers), SSWS-token auth (`OKTA_ORG_URL` / `OKTA_API_TOKEN`), paginated via `Link` header. Team = the user-profile `department` field. Deprovisioned/suspended → leaver with `leave_date` (row retained). Replaced HiBob; attribution still joins on email.

## Critical gotchas (learned the hard way)

1. **PostgREST caps every `.select()` at 1000 rows.** Any read of `spend_facts` — or of any growing table (`employees` retains Okta leavers forever, `sync_runs` grows daily) — **must paginate** with `.order().range(from, from+999)` in a loop until exhausted, and the ORDER BY needs a **unique tiebreaker** (`.order("day").order("id")`) or page boundaries inside a day can duplicate/skip rows. See `fetchFactsInRange` / `fetchEmployeesAll` for the pattern.
2. **Reconciliation only means something when sources fail independently.** Don't "verify" the DB against the same upstream API the DB was built from. Sanity-check against an independent invariant (e.g. cost ≤ tokens × max list price) or a separate source (Claude's own dashboard).
3. **Backfill on the grain you display (calendar months), not API-convenience windows.** Non-month-aligned windows + per-window scaling caused boundary artifacts. (Cursor is exempt — its events self-date.)
4. **Never delete-then-insert when the insert might be empty.** Treat an empty vendor response as "no update," not "wipe." Use `persist.ts:replaceWindowFacts`, which also upserts before pruning so a crash mid-sync can't blank a window, and deletes with `.lt(endDate)` (windows are exclusive-end — `.lte` once wiped a day the fetch never covered).
5. **Vendor list endpoints paginate too.** Anthropic Admin lists (`api_keys`, `users`) page with `has_more`/`last_id`; a bare `?limit=100` silently truncates and attribution degrades to "Unmatched". Follow pages, and throw (don't return partial data) when a page cap is hit.

## Conventions & constraints

- Secrets live **only** in Vercel env (never in the DB, client, or git). `vercel env pull` returns empty for sensitive vars — to inspect prod data, use a temporary `CRON_SECRET`-gated route under `src/app/api/debug/`, then delete it.
- **PII:** `reports/` (HR-adjacent samples) is gitignored — local use only. Production `spend_facts` PII reads are restricted; debug routes should return aggregates, not per-person rows.
- **Deploy only when the user asks.** Branch off `main`; commit/push only when requested.
- Production-DB deletes require explicit per-action user authorization (the auto-mode classifier blocks agent-initiated ones).
- New server actions **must** start with `await requireAdmin()` (`src/lib/auth-guard.ts`); new cron/debug routes gate through `src/lib/cron-auth.ts:isCronAuthorized` (fails closed).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
