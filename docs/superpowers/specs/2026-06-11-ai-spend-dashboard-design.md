# AI Tools Spend Dashboard — Design

**Date:** 2026-06-11
**Status:** Approved for planning
**Source research:** `AI tool admin _ usage analytics - plan comparison.docx` (repo root, vendor docs as of May 2026)

## 1. Purpose

A single internal dashboard tracking AI tool spend per user and per department across five sources, serving three audiences at once:

- **Finance/leadership** — monthly spend rollups per department for budgeting and renewal decisions
- **Ops/IT** — seat hygiene: unused seats, duplicate tool subscriptions per person
- **Engineering/FinOps** — API usage trends on the developer platforms

## 2. Decisions made during brainstorming

| Decision | Answer |
|---|---|
| Stack | Next.js (App Router) on Vercel + Supabase Postgres + Auth.js Google SSO |
| Viewers | Leadership + dept managers; everyone with access sees all data (single tier + admin role) |
| Manual ops | Gareth, monthly (Claude Team CSV export; ChatGPT Business hand entry) |
| Scale | 100–500 employees, low hundreds of seats |
| v1 scope | View-only — no budgets, no alerting |
| History | Backfill what APIs allow at setup; USD only, no FX |
| API spend attribution | Key/project creator is default owner; override mapping is schema-only in v1, UI later |
| Visual quality | Designed as a product — distinctive, polished, data-dense; dark mode |

## 3. Source constraints (from the feature matrix)

| Source | Acquisition | Grain available | Notes |
|---|---|---|---|
| Cursor Teams ($40/seat) | **API** — Admin API | Per-user daily usage + per-event (model, tokens, cost) | 90-day window per request; paginate for backfill |
| Anthropic Console | **API** — Usage (`/v1/organizations/usage_report/messages`) + Cost Report (beta) | Per-API-key, per-workspace, per-model, daily | No end-user dimension; key `created_by` available when listing keys |
| OpenAI Developer Platform | **API** — `/v1/organization/usage/*` + `/v1/organization/costs` | Per-project, per-`user_id` (only if apps pass it), per-key, daily | Admin key is Org-Owner-scoped; cannot be used on data endpoints |
| Claude Team ($30/seat) | **Manual** — CSV spend export from admin UI | Per-user, per-model; daily refresh, 1-day lag | No API on Team plan; Analytics API is Enterprise-only |
| ChatGPT Business ($25/seat) | **Manual** — no documented CSV export; member table visible in UI | Per-user usage in UI only | Entry via clipboard paste of member table, or hand-keyed fields |
| HiBob | **API** — People endpoint, service-user credentials | Employee → department, status, start/leave dates | Identity spine for all joins |

Seat-based tools (ChatGPT Business, Claude Team) carry **two cost components**: allocated seat cost, plus overage/credit usage on top (ChatGPT Business: Codex/workspace credits, per-user credits visible in the member table; Claude Team: per-user per-model spend in the CSV export). Metered tools (Cursor overage, Anthropic, OpenAI): true usage cost. The dashboard must keep this distinction visible (`cost_type = seat | overage | metered`).

## 4. Architecture

```
┌─ Vercel ────────────────────────────────────────────┐
│  Next.js app (App Router)                           │
│  ├─ Dashboard pages (server components, SQL reads)  │
│  ├─ Import UI (CSV upload + manual entry, admin)    │
│  └─ /api/cron/sync  ← Vercel Cron, daily            │
│        ├─ Cursor Admin API                          │
│        ├─ Anthropic Usage + Cost Report APIs        │
│        ├─ OpenAI Usage + Costs APIs                 │
│        └─ HiBob People API                          │
└──────────────────────┬──────────────────────────────┘
                       │
              Supabase Postgres
```

- **Auth:** Auth.js with Google provider, domain-locked to `@intenthq.com`. Two roles: `admin` (imports, identity fixes, sync triggers) and `viewer`.
- **Secrets:** vendor API keys in Vercel env vars only; never in the DB or client.
- **Idempotency:** all fact writes are upserts keyed on `(source, day, entity)`. Re-running a sync or overlapping a backfill cannot double-count.
- **Backfill:** admin-triggered routine at setup; pages backwards through Cursor 90-day windows and OpenAI/Anthropic historical ranges until each API stops returning data.

## 5. Data model

Core tables (names indicative):

- **`employees`** — from HiBob: email, full name, department, site, employment status, start/leave dates. Synced daily; leavers retained (historical spend must keep its attribution).
- **`identities`** — `(vendor, external_email_or_id) → employee_id`, with `match_method: exact_email | alias_rule | manual | unmatched`. Unmatched identities keep their spend rows (attributed to "Unmatched") and surface in an admin queue.
- **`spend_facts`** — one row per `(source, day, grain entity)`: `cost_usd`, `tokens`, `requests` (nullable), `cost_type: seat | overage | metered`, nullable FKs to employee, api_key, project, model string. Single fact table so every rollup is one `GROUP BY`; the UI splits the cost types explicitly. Overage rows: Claude Team per-user per-model spend from the CSV export; ChatGPT Business per-user credit consumption converted to USD via an admin-configured credit rate.
- **`api_keys`** — vendor key registry: external key id, name, `created_by_email`, derived `owner_employee_id`, `owner_override` (column in v1, no UI). Same shape for **`projects`** (OpenAI projects, Anthropic workspaces).
- **`seat_assignments`** — `(vendor, employee, seat_type, monthly_price_usd, period)`. Generates monthly seat-cost facts. Membership comes from each vendor's member list (API or manual import); per-seat prices come from a small admin-maintained config (defaults: ChatGPT Business $25, Claude Team $30, Cursor Teams $40), since vendors don't expose negotiated pricing via API.
- **`sync_runs`** — every automated pull: source, started/finished, status, rows written, error detail.
- **`imports`** — every manual upload/entry: file name or entry type, "data as of" date, status, row counts, row-level errors.

### Attribution rules (v1)

1. Vendor user email → employee via `identities` (exact match, then alias rules, then manual).
2. API key / project spend → `created_by` → employee → department.
3. `owner_override` wins over creator when set (no UI in v1; settable via SQL if urgent).
4. Anything unresolvable → "Unmatched" bucket, visible on Data Health, never dropped.

## 6. Ingestion

### Automated (daily cron)

Each source has a **normalizer**: a pure function `(raw API response) → spend_fact rows`. Raw responses land in a `raw_payloads` table (or object storage) before normalization, so a normalizer bug can be fixed and replayed without re-fetching.

### Manual (monthly, admin UI)

- **Claude Team CSV:** drag-and-drop → parse → validation (unknown emails, negative amounts, overlapping periods flagged per row) → preview table → explicit confirm. Atomic: bad files never partially ingest.
- **ChatGPT Business:** structured entry form. Primary path: paste the member table from the admin UI; we parse the clipboard text, including the per-user **credits** column for overage. Fallback: hand-keyed totals (member count, seat price, total credits used, period). Credits convert to USD via an admin-configured credit rate. Both paths stamp a "data as of" date.

Staleness of manual sources is computed and displayed everywhere relevant ("ChatGPT Business data is 34 days old"), never hidden.

## 7. Dashboard UX

Five viewer pages + one admin page. Global controls: date range, department filter.

1. **Overview** — scorecards (total monthly spend, seat / overage / metered split, MoM delta), 12-month stacked-by-vendor trend, department bar chart, vendor donut.
2. **Departments** — dept × vendor matrix with totals and per-head spend (dept spend ÷ HiBob headcount). Click a department → its people and trend.
3. **People** — searchable, sortable table: person, department, seats held, seat cost, overage, metered spend, last-active (where vendors provide it). Click a person → profile panel: seats, usage, spend history. Sort by "seat cost with zero activity" = seat-hygiene view.
4. **API Platforms** — Anthropic + OpenAI (+ Cursor overage) spend by key/project with creator attribution, model breakdown, per-row trend sparklines.
5. **Data Health** — per-source freshness and last sync status, row counts, manual-import age, unmatched-identity queue with one-click "assign to employee" (admin).
6. **Imports** (admin) — the monthly manual workflow described above, plus manual sync trigger and backfill controls.

### Visual direction

Designed as a product, not a template: custom typography, considered color system (consistent vendor and department color encoding across all pages), data-dense layouts, dark mode. Built on Tailwind + shadcn/ui primitives with Recharts. The frontend-design skill will be used during implementation.

## 8. Error handling

- A failed sync never blocks the dashboard: pages render last-known-good data with freshness indicators; failures appear on Data Health.
- Cron handler isolates sources — one vendor's API failure doesn't abort the others.
- CSV import is all-or-nothing per file, with per-row validation errors shown pre-commit.
- Vendor API schema drift: normalizers validate expected shape and fail loudly into `sync_runs` rather than writing garbage facts.

## 9. Testing

- **Normalizers:** unit tests against recorded fixture responses from each vendor API (the most likely breakage point).
- **Identity matcher:** unit tests covering aliases, case differences, leavers, duplicates, unmatched flow.
- **CSV/clipboard parsers:** unit tests with real export samples plus malformed variants.
- **Rollup queries:** tests asserting seat/overage/metered splits and department totals against a seeded fixture DB.
- Minimal e2e smoke: auth gate works, each page renders with seeded data.

## 10. Out of scope for v1 (explicit)

- Budgets and alerting (thresholds, Slack/email notifications)
- Override-mapping UI (schema only)
- Row-level access (managers see only their dept)
- GBP/FX conversion
- Browser automation for ChatGPT Business scraping

## 11. Risks

| Risk | Mitigation |
|---|---|
| ChatGPT Business export status ambiguous | Entry form designed paste-first with hand-keyed fallback; confirm in tenant early |
| Claude Team CSV window/format undocumented | Validate against a real export in week 1; parser is fixture-tested |
| OpenAI `user_id` attribution only if apps pass it | Treat as bonus dimension; project-level attribution is the dependable grain |
| Vendor API drift | Raw payload retention + replayable normalizers + loud failures |
| HR-adjacent data exposure | Domain-locked SSO, role split, secrets in env vars only |
