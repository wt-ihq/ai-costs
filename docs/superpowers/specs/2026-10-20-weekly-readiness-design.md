# Weekly readiness, Claude Team in the weekly, Monday reminders — design

Amends `2026-09-30-slack-spend-digests-design.md` and `2026-10-09-company-report-design.md`.
Approved in chat 2026-10-20.

## Goal

1. Slack summaries go out **only when the period's data is complete**: no more weeklies on
   Monday at 10:30 whatever state the imports are in, and no more monthlies forced out on the 5th
   with ⚠ caveats.
2. **Claude Team spend counts in the weekly.** It has no API: an admin pastes Claude's month-to-date
   table, now every Monday.
3. Every Monday the admins on a new list get a **reminder DM** saying what's left to do for the week
   (and, on the month's last working day, a reminder to paste Claude Team before its table resets).

## 1. Claude Team spend: keep every paste

Today each paste overwrites one fact per person dated the 1st (`commitClaudeSpendImport`), and
`claude_team` is a monthly-only source (`MONTHLY_SNAPSHOT_SOURCES`), so weeklies and dailies leave
it out.

**New table `claude_spend_snapshots`** keeps every paste:

| column | |
|---|---|
| `as_of` date | the paste's date (its month is the month it belongs to) |
| `email` text | Claude Team member |
| `employee_id` uuid null | resolved at paste time (on delete set null) |
| `mtd_gbp` numeric null, `usd_per_gbp` numeric null | null only for rows seeded from old facts |
| `mtd_usd` numeric not null | month-to-date spend in USD, as pasted |
| `created_by`, `created_at` | |

Primary key `(as_of, email)`. A paste replaces every row with its `as_of` (re-pasting a date is
safe, as now). Only non-zero rows are stored, as now.

**Facts are rebuilt from the snapshots** — pure `ingest/claude-spread.ts:spreadClaudeSnapshots(rows, month)`:

- Per person, take their pastes in the month in date order. Each paste's **increase over their
  previous paste** is spread evenly over the days after the previous paste up to and including its
  own date; the first paste of the month is spread from the 1st.
- A person missing from a later paste keeps their last value (month-to-date never falls; absence
  means they left the table, not that their spend vanished).
- A decrease (a correction) is spread the same way, so the month still adds up.
- Cents are rounded per day with the remainder on the last day, so **each person's month total
  equals their latest paste exactly**. Explore's month view and the monthly recap are unchanged.
- Output: `claude_team` / `overage` facts per (email, day), written by
  `ingest/run-claude-spend.ts:rebuildClaudeSpend(supabase, months)` through `replaceWindowFacts`
  scoped to `claude_team` + `overage` and the month window (upsert first, then prune — a failed
  rebuild never blanks a month). Busts `FACTS_TAG`.

When the rebuild runs:
- after every paste (`commitClaudeSpendImport` writes the snapshot, then rebuilds that month);
- nightly in `runAllSyncs`, for the current and previous month (self-healing, cheap);
- once by hand after deploy: **Data → Sync → "Rebuild Claude Team spend"** rebuilds every month
  that has snapshots (spreads the history).

**Existing data.** Migration 0024 seeds one snapshot per existing `claude_team` overage fact:
`as_of` = the latest successful Claude paste (`imports`, `claude_team`/`clipboard`) dated in that
month, else the month's last day (today, for the current month). So August is spread over August,
October's existing paste over 1 Oct → its date, and each Monday paste after that over its week.

**Where it counts.** `claude_team` leaves `MONTHLY_SNAPSHOT_SOURCES`: weeklies, the weekly chart's
8 weeks, and Explore's day/week views include it. **Daily summaries still leave it out**
(`digest.ts:counted`): an even split is fair across a week, invented for a single day. With no
month-lump source left, Explore's lump handling (`MONTHLY_SNAPSHOT_SOURCES`, `snapshotAsOf`:
amortising a paste over 1st → as-of, pacing it in projections) is retired. Explore scopes lose
`snapshotAsOf`, so `CACHE_VERSION` is bumped in the same commit.

**The paste form** (`components/claude-spend-import.tsx`) defaults its date to **yesterday on a
Monday** (the table includes Monday morning; counting it as of Sunday puts the week's spend in the
week — the small Monday-morning spillover into the previous week is accepted), **today otherwise**
(the month-end paste is as of its own day).

**Month end.** Claude's table resets at the start of a month, so the month's last days are only
captured by a paste on its last working day. Without one they're missing from the monthly recap as
well (true today too). The month-end reminder (§4) asks for it. When a month ends on a weekend,
the last-working-day paste misses the weekend.

## 2. When a week is ready

Pure `notify/readiness.ts:weekReadiness(...)` for a Monday–Sunday week, from data the run already
has or can read cheaply:

1. **Automatic syncs.** Every synced source (`SYNCED_SOURCES`) that is *in use* — a successful run
   in the loaded sync-run window — has a successful run started on or after the Monday the week
   ended. One failed source holds the week.
2. **ChatGPT credits** imported through Sunday: the latest successful credits CSV import's
   `data_as_of` ≥ the week's last day.
3. **Claude Team** pasted as of Sunday or later: the latest successful Claude paste's `data_as_of`
   ≥ the week's last day.

(2) and (3) apply only when that import was used in the last two months (any successful import of
that kind with `data_as_of` in the current or previous two months) — the rule `monthlyReadiness`
uses, read from the `imports` log rather than import coverage, which pages through every manual
fact and grows ~30× once Claude Team is daily.

Returns `{ ready, outstanding }`, each outstanding item one of
`{ kind: "sync", source, lastSuccessDay }`, `{ kind: "chatgptCredits", through }`,
`{ kind: "claudeSpend", asOf }`. Used by the run (to hold), the reminder (to list) and the admin
status line (to show) — one definition of "ready".

Monthly readiness is the existing `monthlyReadiness` (all four manual columns present) plus (1)
for the month.

## 3. Sending

`schedule.ts:dueDigests(day, { weekReady, monthReady })`:

- **Weekly**: due on **every working day** (Mon–Fri) for the latest complete week, when
  `weekReady`. Each person still gets it at their first run from 10:30 local, and the send log
  (claim key unchanged) means once. A week that isn't ready by Friday is **skipped**: on Monday
  `latestCompleteKey` moves to the new week. Nothing partial goes out.
- **Monthly**: due on every working day from the 3rd (as now) **to the month's end**, when
  `monthReady`. **No more forcing on the 5th**; `DueDigest.force` and the forced-caveat path go.
  The 3rd stays the earliest day (the month-to-date resync runs through the 3rd).
- **Daily**: unchanged (still held until a sync since the day began).

The company report follows the same rules (it shares `dueDigests`).

## 4. Reminders

**Recipients**: new table `notification_reminder_recipients (employee_id pk, created_by,
created_at)`, edited on Data → Notifications ("Update reminders", add/remove — server actions,
`requireAdmin()` first). The admin who asked for this adds themselves after deploy.

**When** (each recipient's own Slack time zone, working days):
- **Monday from 09:30**: the weekly reminder, period key = the week's ISO key, cadence `weekly`.
- **The month's last working day from 15:00**: the Claude Team month-end reminder, period key =
  the month, cadence `monthly`.

**Send log**: reminders are claimed in `notification_sends` like digests, with a new report kind
`reminder` (claim-before-send, never twice). `NotifyStore.everLive` counts only `personal` and
`company` sends, so a reminder never uses up someone's first-message intro. Preview mode sends them
to `SLACK_PREVIEW_EMAIL` with the usual preview line; off mode sends nothing.

**Monday message** (`notify/reminders.ts`, pure):

```
🗓 Weekly updates · 12–18 Oct 2026
⬜ Claude Team spend — pasted as of 11 Oct. Paste this morning's table (dated 18 Oct).
⬜ ChatGPT credits — imported through 11 Oct. Import a file through 18 Oct.
⬜ OpenAI didn't sync since Sunday — re-run it on Data → Sync.
✅ Everything else is in.
October's monthly recap is waiting too: ⬜ Claude Team seats (invoice counts)
24 weekly summaries go out automatically once everything's in.
[Open Data → Imports]
```

Done items are left out; when nothing is outstanding it says "✅ Everything's in for 12–18 Oct.
Weekly summaries go out from 10:30." The monthly line appears only while a monthly recap is due and
not ready (its `monthlyReadiness.missing` labels). The count is the weekly recipients not yet sent.

**Month-end message**:

```
🗓 Paste Claude Team spend today
Claude's table resets when the month ends. Pasting it today (dated today) captures October's last
days for the monthly recap and the weekly summaries.
[Open Data → Imports]
```

## 5. Admin views

- **Data → Notifications**: the "Update reminders" list, and a status line from `weekReadiness`:
  "Weekly 12–18 Oct: waiting for Claude Team (pasted as of 11 Oct)" / "ready — going out from
  10:30" / "sent to 24 of 24" / "skipped — not ready by Friday". Same for a pending monthly.
- **Data → Imports**: the checklist's Claude spend item reads weekly ("Pasted as of 18 Oct" / "Due:
  paste as of 18 Oct"); its action and anchor are unchanged.
- **Data → Sync**: the "Rebuild Claude Team spend" action (all months with snapshots).

## Migration `0024_weekly_readiness.sql` (apply before deploy)

1. `claude_spend_snapshots` (+ RLS enabled, no policies — service role only).
2. Seed it from `spend_facts` (`claude_team`, `overage`) as in §1. Inserts only; no deletes.
3. `notification_reminder_recipients` (+ RLS).
4. `notification_sends.report` check → `('personal', 'company', 'reminder')`.

Deploy order: apply 0024 → deploy → Data → Sync "Rebuild Claude Team spend" (before the next
Monday) → add yourself to Update reminders. Until the rebuild, old months are still one lump on
the 1st, which would show as a spike in the week containing the 1st.

## Tests

- `claude-spread.test.ts`: first paste spread from the 1st; weekly increments; carry-forward of an
  absent person; a decrease; per-person totals equal the latest paste to the cent; re-paste replaces.
- `readiness.test.ts`: each outstanding kind; the in-use rules; a week straddling two months.
- `schedule.test.ts`: weekly due Mon–Fri only when ready, not at weekends; monthly due from the 3rd
  to month end when ready, never forced; reminder timing (Monday 09:30, last working day 15:00,
  time zones).
- `reminders.test.ts`: outstanding lines, the all-done text, the monthly line, the count.
- `digest.test.ts`: Claude Team counted in weekly and monthly, left out of daily.
- `run-notify.test.ts` (memory store): weekly held while not ready, sent on Wednesday when ready,
  skipped after Friday; reminder sent once per period and not counted by `everLive`.
- `checklist.test.ts`: the weekly Claude spend wording.

## Out of scope

- Splitting a week's Claude Team spend by day (it's an even spread).
- Recovering a month's last days when the month-end paste was missed.
- Nudges after Monday if the week is still incomplete (the status line shows it).
