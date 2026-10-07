# Fixed costs in Slack digests — design

Amends `2026-09-30-slack-spend-digests-design.md`. Approved 2026-10-07.

## Goal

Admins choose whether Slack digests include fixed costs — **seats and
subscriptions** (`cost_type` `seat` | `subscription`) — with an
organisation default and per-team / per-person overrides.

## Resolution

person override → team (Okta department) override → organisation default.
The default is **exclude**. A digest uses the **recipient's** setting for every
section in it (a manager's "Your reports" follows the manager). A team digest
(admin preview / test send) uses that team's setting, else the default.

## What the setting does

| | Exclude (default) | Include |
|---|---|---|
| Daily | usage only (unchanged) | + each day's share of its month's seats & subscriptions (cost ÷ days in month — Explore's day-view rule) |
| Weekly | usage only (unchanged) | + the sum of those daily shares (a week spanning two months takes each month's share) |
| Monthly | **usage only** — seats & subscriptions dropped | full total as posted (unchanged; matches Explore) |

- Headline, chart bars, the "vs previous" comparison and the month line
  ("September so far … on track for …") all follow the setting. (Before this,
  the month line always included fixed costs.)
- The basis label follows: `TOTAL` when included, `USAGE` when excluded.
- Claude Team's month-to-date paste is **usage, not a fixed cost**: monthly
  digests always count it; daily/weekly still leave it out (it arrives as one
  monthly lump) — unchanged. Spreading it over its covered days is a possible
  follow-up.

## Data

Migration `0017_notification_settings.sql`:

```sql
create table notification_settings (
  scope         text not null check (scope in ('org', 'department', 'employee')),
  scope_key     text not null,  -- '' for org; the department name; the employee id
  include_fixed boolean not null,
  updated_by    text not null,
  updated_at    timestamptz not null default now(),
  primary key (scope, scope_key)
);
```

No org row = the default (exclude). Read once per run / preview (tiny table).
Apply to production **before** deploying — every digest run reads it.

## Code

- `src/lib/notify/fixed-costs.ts` (pure): `FixedCostSettings`,
  `fixedCostsFor(settings, employee)` / `fixedCostsForTeam(settings, dept)` →
  `{ include, source: "person" | "team" | "default" }`.
- `digest.ts`: `SectionInput.includeFixed`; one `counted()` rule per
  (cadence, includeFixed) as in the table; fixed facts spread by day only for
  months overlapping the chart span.
- `context.ts`: `NotifyContext.fixedCosts`, loaded with everything else;
  `digestFor` / `teamDigestFor` resolve the setting. Cron, preview and test
  sends all go through these, so they agree.
- Admin (Data → Notifications): a **Fixed costs** panel (org default switch,
  team overrides add/change/remove) and a **Fixed costs** column on the
  recipients table (Default / Include / Exclude). The preview states which
  setting applied and why. Server actions start with `requireAdmin()`; no
  `spend_facts` writes, so no cache-tag bust.

## Tests

Resolution precedence; daily/weekly/monthly counting under both settings
(incl. a week spanning two months); labels; month line; digestFor/team
digests honouring overrides; admin-store writes.
