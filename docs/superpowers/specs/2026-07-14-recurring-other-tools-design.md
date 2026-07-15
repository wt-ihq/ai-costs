# Recurring Costs for Other AI Tools

**Date:** 2026-07-14
**Status:** Approved design

## Problem

AI tools outside the five tracked vendors (e.g. Perplexity, ElevenLabs) have
real spend — up to ~$2,500/month — with no way into the dashboard. Some are
monthly subscriptions; some are annual contracts paid up front that should be
spread across the contract period, and each belongs to a specific department.

## Decisions (agreed with Gareth)

1. **Entry model**: per tool — department (chosen from existing departments,
   blank → Unattributed), and either a **monthly price** (start month,
   optional end month, auto-continues) or an **up-front contract** (total,
   start month, end month required) amortized evenly across its months.
   Price change = end the entry, add a new one.
2. **Currency**: `USD` / `GBP` / `EUR` per entry, with an entered →USD rate
   (original amount + rate stored; all facts stay USD).
3. **First-class presentation**: each tool is its own vendor in charts —
   own filter chip, own trend series, own composition row — with a colour
   **assigned once at first entry** from a reserved 8-hue palette (stored,
   never repaints; beyond 8 tools colours reuse and we revisit).
4. **Cost category**: `seat` (fixed cost — stacks at the base).
5. Costs land on the chosen **department's row** in Explore.

## Design

### Migration 0008

```sql
alter type vendor add value 'other';
alter table spend_facts add column department text;  -- fact-level attribution (recurring costs have no employee)

create table recurring_costs (
  id          uuid primary key default gen_random_uuid(),
  tool        text not null,            -- display name; tool identity = lower(tool)
  color_slot  integer not null check (color_slot between 0 and 7),
  department  text,                     -- null => Unattributed
  kind        text not null check (kind in ('monthly', 'contract')),
  amount      numeric not null check (amount >= 0),  -- per month (monthly) or total (contract)
  currency    text not null default 'USD' check (currency in ('USD', 'GBP', 'EUR')),
  fx_rate     numeric not null default 1 check (fx_rate > 0),  -- to USD
  start_month date not null,            -- YYYY-MM-01
  end_month   date,                     -- inclusive month; REQUIRED for kind='contract'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
```

(Postgres note: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction
with other statements — the migration file separates it, and the manual
prod application runs it as its own statement.)

### Pure computation — `src/lib/ingest/recurring.ts`

`computeRecurringFacts(entries, throughMonth): ResolvedFact[]`
- **monthly**: one fact per month from `start_month` through
  `min(end_month ?? throughMonth, throughMonth)`, each
  `round(amount × fx_rate, 2)` USD.
- **contract**: `totalCents = round(amount × fx_rate × 100)` split across the
  contract's months — `floor(totalCents / n)` per month, the **last month
  absorbs the remainder** (cent-exact) — materialized only through
  `throughMonth` (future months appear as time passes).
- Aggregated per `(tool, month, department)` into one fact:
  `source: "other"`, `day: month`, `costType: "seat"`,
  `entityKey: lower(tool) + (department ? "|" + department : "")` (keeps the
  unique fact key collision-free if a tool ever spans departments),
  `model: tool` (display name — drives per-tool labels), `department`,
  `employeeId: null`.

### Materializer + cron

`rebuildRecurringFacts(supabase)`: read all `recurring_costs` (paginated,
gotcha #1), compute through the current UTC month, snapshot-replace the whole
`other` source window `[earliest start_month, current month + 1)` via
`replaceWindowFacts`. **Zero entries** is the one intentional full-clear:
`other` facts are purely derived from the table, so an explicit
`delete where source='other'` is safe and documented (the source of truth is
`recurring_costs`, not the facts — a deliberate, narrow exception to
gotcha #4's spirit).

Triggers: the save/end/delete server actions, plus a nightly source-isolated
`recurring` cron step in `run-all.ts` (extends open-ended monthlies into each
new month; `sync_runs` source `"recurring"`, folded onto the new "Other
tools" Data Health row).

### Readers — department-attributed facts

- `fetchFactsInRange` selects the new `department` column;
  `EnrichedFact.department = fact.department ?? employee.department`.
- `getTeamScope(team)` additionally fetches facts with
  `department = team` (today it only fetches by employee ids). The
  Unattributed scope conversely excludes facts that carry a department.
- `rankTeams` needs no change (it already groups by the shaped department).

### First-class vendor presentation

- `Vendor` union and `VENDOR_LABEL`/`VENDOR_COLORS` gain `other`
  ("Other tools", neutral grey) as the fallback identity.
- **Dim key**: for `source === "other"`, the vendor-dimension key becomes
  `other:<tool>` (from `model`); label = the tool name; color = the tool's
  stored `color_slot` in a new reserved `OTHER_TOOL_PALETTE` (8 hues,
  validated against both surfaces with the dataviz checker, distinct from
  the 5 vendor hues).
- A `toolColors: Record<string, string>` map (tool → hex, from
  `recurring_costs`) flows from the page queries into the shapers/components
  that color vendor keys: trend chart, vendor filter chips, composition
  panel, ranked-bar segments, treemap. Unknown tools fall back to the
  `other` grey.
- The **vendor filter** accepts `other:<tool>` values (chip per tool);
  filtering by a tool scopes facts to `source='other' AND model=<tool>`.
- `color_slot` assignment: first entry for a new tool name takes the lowest
  slot not used by any existing tool; when all 8 are taken, the least-used
  slot is reused.

### UI — Imports page card "Other AI tools"

Form: tool name (datalist of existing tools), department (datalist of
existing departments), kind toggle (Monthly / Contract), amount + currency
select + rate (rate hidden for USD; prefilled from the tool's last entry,
else 1.27 GBP / 1.17 EUR), start month, end month (optional for monthly,
required for contract). Entries table: tool (with its colour dot),
department, terms ("£40/mo from 2026-03" / "€12,000 Jan–Dec 2026 ≈
$1,170/mo"), monthly USD equivalent, and **End** (sets end_month to last
month) / **Remove** (deletes the row) actions. All actions
`requireAdmin()`-gated; rebuild after each.

### Data Health

"Other tools" row appears automatically (`other` joins `VENDOR_LABEL`);
its sync cell folds the `recurring` cron run (same pattern as the seat
syncs). Coverage table untouched.

**Unmatched-queue guard:** recurring facts have no employee, so without a
guard they would surface as "assignable" unmatched identities. The
data-health unmatched classification treats facts with a `department` as
attributed — only facts with BOTH `employee_id` and `department` null enter
the unmatched/pseudo queues.

### Out of scope

- Per-person attribution for these tools (department-level only).
- Editing an entry's amount in place (end + re-add, as decided).
- More currencies (add on demand).
- Automatic FX rates (manual, like the Claude imports).

## Testing

- Amortization: cent-exact contract split (incl. remainder month and £/€
  conversion), monthly auto-continuation clipped at `throughMonth`,
  end-month clipping, per-(tool, month, department) aggregation.
- Color-slot assignment: lowest free slot, stable across unrelated changes,
  wrap past 8.
- Dim key/label/color for `other` facts incl. fallback; vendor filter with
  `other:<tool>` values.
- Readers: fact-department preference; team scope includes
  department-attributed facts; Unattributed excludes them.
- Materializer: zero-entries clear documented + tested via fake client.
- Changelog; `npm run test` + `CI=true npm run build`.

## Rollout

1. Apply migration 0008 to prod (note the enum-ALTER separate-statement rule).
2. Deploy; add the first tool; check Explore (tool chip, department row) and
   Data Health.
