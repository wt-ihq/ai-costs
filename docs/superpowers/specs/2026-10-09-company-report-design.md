# Company AI spend report — design

Amends `2026-09-30-slack-spend-digests-design.md`. Approved in chat 2026-10-09.
Replaces the unmerged `digest-company-fixed-costs` branch (a "company seats &
subscriptions" section inside AI Operations' digests). That branch is not
merged and its migration was never applied. Its month-comparison and caveat
pieces are reused here.

## Goal

A **whole-company report** in Slack: the company's AI spend for the period,
the teams and people behind it, and the company's seats & subscriptions bill.
Admins choose who receives it and on which cadences. It is a separate DM from
the personal digest, so someone can get either, both or neither.

## What it shows

```
📊 Company AI spend · 5–11 Oct 2026

COMPANY · 142 PEOPLE
[chart: last 8 weeks by tool; the headline total drawn in]
Engineering $2,900 · Data Science $1,450 · … · +8 teams $1,070 · unattributed $210
Alex Kim $410 · Sam Lee $380 · … · +120 others $3,900 · not tied to a person $640
Anthropic API $3,100 · Cursor $1,400 · …
October so far $9.8k · on track for ~$27k

SEATS & SUBSCRIPTIONS
$4,127 total · a week's share of the monthly bill
<tool> $1,344 · <tool> $779 · …
October $18,277 · no change vs September

[caveats, as in personal digests]
[Open in dashboard]
```

### Company section (always usage)

- **Population:** every fact except seats & subscriptions. Claude Team's monthly
  paste counts in monthlies only, as in every digest (`digest.ts:counted` with
  fixed costs excluded).
- **Headline, chart, comparison and month line** work as in a team digest. The
  title is `COMPANY (142 PEOPLE) · USAGE, <PERIOD>`. Headcount counts active
  employees.
- **Top teams line:**
  - Teams are grouped as Explore's Company page groups them (`rankTeams`): by
    the fact's department, else the person's.
  - It shows the top 5, each linked to its team page, then `+N teams $X`.
  - Spend with no team comes last as `unattributed $X`, never inside `+N teams`.
- **Top people line:**
  - It shows the top 5 people company-wide, each linked to their person page,
    then `+N others $X`, where "others" means people only.
  - Spend that belongs to no person (unkeyed rows, workspace keys, team-level
    charges) is its own item: `not tied to a person $X`. This mirrors the team
    digest's `team-level costs`.
- **Tools line:** as in other digests.

### Seats & subscriptions section (text only, no chart)

- **Population:** every seat and subscription fact company-wide, including
  shared and person-less ones. The recipient's include/exclude setting is
  ignored: the report always shows usage and fixed costs apart.
- **Daily and weekly:**
  - The headline is the period's share of the monthly bill (cost ÷ days in
    month, the existing `spreadOverMonth`), labelled "a day's share of the
    monthly bill" or "a week's share of the monthly bill".
  - There is no period-on-period change, because a share only moves with month
    length.
  - Instead, a line compares whole months as posted: the month the period ends
    in against the month before (`October $18,277 · ▼ 1% vs September`; under
    0.5% reads "no change"; no prior month shows the figure alone).
- **Monthly:** the month as posted, compared with the previous month.
- **Tools line:** the bill's tools for the period.

### Monthly only

A final line, `September 2026 total $X · usage + seats & subscriptions`, adds
usage and seats & subscriptions. It
equals Explore's Company total for the month: together the two sections count
every fact once.

### Common rules

- **Caveats** (stale sync, missing import) cover the sources counted in the
  company section plus the **seat** sources in the second section.
  Subscriptions come from `recurring_costs`, which no sync can leave stale.
- **Skips:** a daily with no usage is skipped ("no usage"); the bill alone never
  makes a daily. Weeklies and monthlies always send.
- **Button:** "Open in dashboard" goes to `/explore` (the Company page). It is
  tracked like personal digests.
- **Plain-text fallback:** `Company AI spend · <period>: usage $X · seats &
  subscriptions $Y`.

## Who gets it, and when

- **Recipients:** a new **Company report** panel on Data → Notifications lists
  the recipients. Admins add a person with cadences (daily, weekly, monthly),
  tick or untick cadences, and remove people. Leavers are shown as left and are
  never sent anything.
- **Schedule:** identical to personal digests.
  - It sends at 10:30 in the recipient's Slack time zone, on working days.
  - Monday's daily covers Friday, and weeklies go out on Monday.
  - Monthlies go out once the imports are in, within the monthly window.
  - Sends are held when no source has synced.
  - `SLACK_NOTIFY_MODE` applies. In preview, the DM goes to
    `SLACK_PREVIEW_EMAIL` with "would send to <name> (company weekly)".
- **Separate DM:** someone on both lists gets two messages.
- **Preview and test send:** the admin preview picker gains a **Company**
  subject (`?company=1&cadence=…&at=…`). A test can go to the admin or to any
  active employee; there is no "send to the subject" option.

## Data

Migration `0019_company_report.sql`. Apply it to production **before**
deploying: the cron reads the new table and writes the new column on every
run.

```sql
create table notification_company_recipients (
  employee_id uuid not null references employees(id) on delete cascade,
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (employee_id, cadence)
);
alter table notification_company_recipients enable row level security;

alter table notification_sends
  add column report text not null default 'personal' check (report in ('personal', 'company'));
alter table notification_sends drop constraint notification_sends_employee_id_cadence_period_key_mode_key;
alter table notification_sends
  add constraint notification_sends_employee_cadence_period_mode_report_key
  unique (employee_id, cadence, period_key, mode, report);
```

**Why a separate table:** changing `notification_subscriptions`' key instead
would break the running code's `onConflict: "employee_id,cadence"` upsert in the
minutes between applying the migration and deploying.

**Send-log column:** the code already running keeps working. Its rows default
to `personal`, and no `company` row exists until the new code sends one.

## Code

- **`types.ts`:** `ReportKind = "personal" | "company"`.
- **`store.ts`:**
  - `SendKey` gains `report`, carried through `keyMatch`, `sendStates`,
    `claimSend` and `finishSend`.
  - New `companyRecipients(cadences)`.
  - `markOpened` also returns the send's `report`.
  - `memory-store.ts` follows.
- **`digest.ts`:**
  - `buildCompanyDigest(input)` returns a `CompanyDigest` (`kind: "company"`).
    The usage section has headcount, top teams, unattributed, top people,
    others and not-tied-to-a-person amounts. The fixed section carries a
    `monthTotal` for daily and weekly. A monthly also carries `totalUsd`.
  - `MonthTotal` / `monthTotal` / `sourcesIn` / `caveatsOf(sources)` come from
    the abandoned branch.
- **`context.ts`:** `companyDigestFor(ctx, period)`, with no fixed-cost
  resolution.
- **`render.ts` / `deliver.ts`:**
  - New `renderCompanyDigest` and `companyChartTitle`.
  - New `chartLayoutsForCompany`, which draws one chart (usage).
  - New `deliverCompanyDigest`.
  - `monthTotalLine` and the share wording come from the abandoned branch.
- **`run-notify.ts`:**
  - Candidates come from both lists, each tagged with its `report`. The Slack
    lookup, `sendDay`, due check and already-handled check are shared.
  - The company digest is built **once per period per run** and reused for every
    company recipient. Only the tracked open link differs.
  - Claim, send and record work exactly as today, keyed with `report`.
- **`opens.ts`:** a company send redirects to `/explore`.
- **Admin (`admin-store.ts`, `notifications-actions.ts`, `notifications-tab.tsx`):**
  - **Company report panel:** loads `companyRecipients` (name, team, cadences,
    Slack status, left). Server actions: `addCompanyRecipients`,
    `setCompanyRecipientCadence` and `removeCompanyRecipient`. Each starts with
    `await requireAdmin()` and validates input as the personal ones do.
  - **Recent sends:** a **Report** column shows Personal or Company.
  - **Pilot recipients:** "last sent" counts personal sends only.
  - **Opens:** the open rate counts both kinds.
  - **Preview and tests:** `TestSubject` gains `{ kind: "company" }`.
    `sendTest` builds the company digest. Its banner reads `🧪 Test: the company
    <cadence> report, sent to you by <admin>`. Tests are never written to
    `notification_sends`, as today.
- **No `spend_facts` writes:** so no cache-tag bust, and no `*Cached` reader
  changes, so no `CACHE_VERSION` bump.
- **Docs:** a CHANGELOG entry and the CLAUDE.md Slack digests paragraph.

## Tests

- **Company digest:**
  - Usage only, whatever the fixed-costs setting.
  - Top teams follow `rankTeams`' grouping, with unattributed apart and
    `+N teams` correct.
  - Top people, with others counting people only and not-tied-to-a-person apart.
  - Headcount counts active employees.
  - The daily skip.
- **Seats & subscriptions:**
  - The daily and weekly share, with the month comparison (including a week
    spanning two months).
  - Monthly as posted against the previous month.
  - The monthly total equals the sum of every fact in the month.
- **Caveats:** sources from usage plus seats only.
- **Render:**
  - The header, both sections, team and people lines (escaped, linked) and
    month lines.
  - The monthly total line, the text fallback, and the tracked button.
- **Run:**
  - Personal and company sends for the same person and period are claimed
    separately.
  - A company recipient with no personal subscription is sent the report.
  - It is built once per period.
  - Already-handled checks respect `report`.
  - Preview mode, and leavers skipped.
- **Store:** `report` in keys. **Opens:** a company redirect. **Test send:** the
  company subject.
