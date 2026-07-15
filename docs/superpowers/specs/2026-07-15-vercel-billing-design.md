# Vercel Spend via the FOCUS Billing API

**Date:** 2026-07-15
**Status:** Approved design

## Problem

Vercel hosting spend (plan seats + metered usage) is invisible to the
dashboard. Vercel exposes it via `GET /v1/billing/charges` — FOCUS v1.3
JSONL, 1-day granularity, max 1-year range, exclusive-end `from`/`to`
(matching this repo's window convention), bearer-token auth. Records carry
`BilledCost` (USD), `ChargeCategory` (Usage/Purchase/Credit/Adjustment/Tax),
`ChargePeriodStart/End`, `ServiceName`, and `Tags.ProjectId`/`ProjectName`.

## Decisions (agreed with Gareth)

1. **Attribution: project → department.** Each Vercel project maps to a
   department (fact-level `department`, as built for recurring tools);
   unmapped projects land Unattributed until assigned. No person attribution.
2. **Cost types:** `Purchase` → `subscription` (plan/seat charges),
   `Usage` → `metered` (API), `Credit`/`Adjustment` → `metered` with their
   (negative) amounts passed through, `Tax` → `subscription`.
3. **Scope:** the jml-ihq team only, via new secrets `VERCEL_BILLING_TOKEN`
   + `VERCEL_TEAM_ID` (Vercel env only, like every other credential).
4. Vercel is a **first-class vendor** (`vercel` enum value, label "Vercel",
   color `#cbd5e1` — bright neutral, distinct from the palette).

## Design

### Migration 0010

```sql
alter type vendor add value 'vercel';  -- own-statement rule, as 0008/0009

create table vercel_projects (
  id           uuid primary key default gen_random_uuid(),
  project_id   text not null unique,   -- Tags.ProjectId
  project_name text not null,          -- Tags.ProjectName (refreshed each sync)
  department   text,                   -- null => Unattributed
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
```

### Source — `src/lib/ingest/sources/vercel.ts`

`fetchVercelCharges(window): Promise<FocusCharge[]>` — GET
`https://api.vercel.com/v1/billing/charges?from=<startDate>&to=<endDate>&teamId=$VERCEL_TEAM_ID`
with `Authorization: Bearer $VERCEL_BILLING_TOKEN`. Parses the JSONL stream
line-by-line (skip blank lines; a malformed line throws `SchemaDriftError` —
never silently drop money). Retries 429/5xx with the same backoff pattern as
the Okta fetcher. Throws early when env vars are unset. Injectable for tests.

### Normalizer — `src/lib/ingest/normalizers/vercel.ts`

`normalizeVercel(charges): SpendFact[]` (fixture-tested, `SchemaDriftError`
on unknown `ChargeCategory` or missing required fields):
- `day` = `ChargePeriodStart` date part (1-day records).
- `costType`: Purchase/Tax → `subscription`; Usage/Credit/Adjustment →
  `metered` (credits are negative `BilledCost`, passed through — the day's
  net is what Vercel bills).
- `entityKey` = `Tags.ProjectName ?? Tags.ProjectId ?? "team"` (team-level
  charges like the plan fee have no project).
- `model` = `ServiceName`.
- `costUsd` = `BilledCost` (the invoicing basis; `EffectiveCost` ignored).
- Aggregated per `(day, costType, entityKey, model)`; `employeeId: null`;
  `department` attached at persist time from the project map.

### Orchestrator — `src/lib/ingest/run-vercel.ts`

`syncVercel(supabase, window)`:
1. Fetch charges for the window; save raw payload.
2. Upsert newly-seen projects into `vercel_projects`
   (`onConflict: project_id`, refreshing `project_name`, never touching an
   assigned `department`).
3. Load the project→department map; attach `department` to each fact by
   **ProjectName** match (entity keys are names for readability, like
   Cursor's emails; a renamed project starts a new entity key and old
   months keep the old name — mirrors reality). Team-level facts stay null.
4. `replaceWindowFacts(supabase, "vercel", window, facts)` (snapshot
   semantics; empty response can't wipe — gotcha #4).

Registered source-isolated in `run-all.ts` (name `"vercel"`) using the same
month-to-date window as the other metered sources; added to the manual
`backfillSync` source list (the API allows a year of history — backfill in
monthly windows, gotcha #3).

### Attribution surfaces

- Facts carry `department` (fact-level, already flowing through the
  readers) → team rows on Explore.
- **Data Health**: `source === "vercel"` facts skip the unmatched queues
  (projects map to departments, not people — same guard as `other`). The
  vendor row appears automatically; its sync cell shows the `vercel` run.
- **Team pages**: the Tools list generalizes to person-less,
  department-attributed facts of any source — retitled **"Tools &
  infrastructure"** — so a team's Vercel projects list beside its recurring
  tools (`rankTools` includes `source === "vercel"` rows grouped by
  entityKey, sub "Vercel project").

### Mapping UI — Imports page card "Vercel projects"

Lists every row of `vercel_projects` (name + current department) with a
department datalist + Save per row (`requireAdmin()`-gated action that
updates the mapping and re-attaches: a `refreshVercelDepartments` that
updates the `department` column of existing `vercel` facts for that
project's entityKey — a scoped `update`, no window games). New projects
appear automatically after each sync.

### Out of scope

- Multiple Vercel teams (single-team env config).
- Per-person attribution (project→department only).
- `EffectiveCost`/committed-spend analysis; `RegionId`; service-category
  rollups beyond `ServiceName`-as-model.
- Alerting on spend spikes.

## Testing

- Normalizer fixtures: usage + purchase + credit (negative) + tax records,
  project and team-level tags, aggregation, unknown-category →
  `SchemaDriftError`, malformed JSONL line → throw.
- Fetcher: env guard, JSONL parse, retry/backoff (fetch-mocked).
- Orchestrator: project auto-registration never clobbers an assigned
  department (fake client); department attachment.
- rankTools generalization: vercel rows appear with the right sub; existing
  recurring-tool behavior unchanged.
- Changelog; `npm run test` + `CI=true npm run build`.

## Rollout

1. Apply migration 0010 (enum line alone first).
2. Create a Vercel token with billing read access for jml-ihq; add
   `VERCEL_BILLING_TOKEN` + `VERCEL_TEAM_ID` to the Vercel env.
3. Deploy; trigger a manual sync; assign departments to the projects that
   appear on the new card; backfill up to 12 months from the Imports page.
