# Notification controls: mode switch, Send now, Remove everyone

**Date:** 2026-10-26 · **Status:** design, awaiting approval
**Builds on:** `2026-09-30-slack-spend-digests-design.md`, `2026-10-20-weekly-readiness-design.md`

## Why

The Slack digests have been running in preview for weeks. Going live today means
editing `SLACK_NOTIFY_MODE` in Vercel, waiting for the next hourly run, and trusting
the 10:30 schedule. The admin can see on Data → Notifications that the week's
figures are complete, but cannot act on it from there. And the pilot list (43 people)
can only be emptied one Remove click at a time.

The admin (Gareth) described the moment: *"the dashboard tells me that the data has
been added and it's ready to send. Show me when it will be sent automatically, or
allow me to send manually. All users who are in the recipients list will get the
notification. Ensure that if they were in preview mode before, those recipients will
still see the introductory message."*

## Goals

1. Change the mode (off / preview / live) on Data → Notifications, without a deploy
   or a Vercel visit.
2. The week panel says plainly what will happen next and when: waiting for X, ready
   and going out automatically at a stated time, sent, or skipped.
3. A **Send now** button per digest sends it (personal digests and the company
   report) to everyone on the lists immediately, recorded so the scheduled run never
   sends it again. The weekly can be sent before it is ready ("Send anyway"); the
   monthly only once ready.
4. A **Remove everyone** button empties the Pilot recipients list.
5. People who only ever received previews still get the first-message intro the
   first time a live message reaches them, by schedule or by Send now.
6. When adding people to the Pilot list, an option sends them the latest weekly and
   monthly straight away, so a late joiner isn't left waiting a week.

## Non-goals

- Send now for the daily digest.
- Sending a monthly with incomplete figures. "Send anyway" exists for the weekly
  only; the monthly is what people compare with invoices.
- Changing the preview inbox from the page. `SLACK_PREVIEW_EMAIL` stays in Vercel.
- Emptying the company-report or reminder lists. Each row keeps its own Remove.
- Any change to what the digests say.

## Anti-goals (would make this a failure even if it works)

- A duplicate DM. Send now and the hourly run must never both deliver the same
  weekly to the same person.
- A live DM that nobody chose. Switching to live must be a deliberate, confirmed act,
  and the page must make the current mode obvious.
- Losing people's settings on Remove everyone: per-person fixed-cost choices and
  the send history must survive, so re-adding someone restores them.

## Constraints (existing rules this must respect)

- Every server action starts with `await requireAdmin()`.
- Send log is claim-before-send (`notification_sends`); never make a row retryable
  once a DM may have gone out. The claim key includes `mode`, so preview sends never
  count as live, and `everLive` only sees live rows. **This is what makes goal 5 true
  today**; the work is to keep it true and lock it with a test.
- Secrets stay in Vercel env. The mode is not a secret; the bot token and preview
  email are.
- The hourly cron must stay cheap: it checks who is due and what is handled before
  loading spend data.
- Plain-language copy everywhere a user reads it, and a "What's new" changelog entry.

## The parts

### 1. Mode lives in the database

A new table (migration `0026`, **applied to production before deploy**):

```
notification_config (
  key        text primary key,      -- 'mode'
  value      text not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
)
```

One row, `key = 'mode'`, `value in ('off','preview','live')`.

**Resolution rule** (pure, tested): the stored value wins; if there is no row, fall
back to `SLACK_NOTIFY_MODE` from the environment; anything else is `off`. The cron
route, the admin page and the Send now action all read the mode through this one
function. `sendTestDigest` keeps ignoring the mode, as today.

*Builder's call (reviewer question 3):* the stored value is honoured only on the
production deployment (`VERCEL_ENV === "production"`) and in local development; a
Vercel preview deployment uses the environment variable alone. Today every Slack and
Supabase variable is scoped to Production only, so previews can't send anyway; the
guard is defence in depth and costs one condition and one test.

**UI**: the Mode panel shows the current mode in words ("Preview: every message goes
to gareth.jones@…, nobody else", "Live: messages go to the people on the lists",
"Off: nothing is sent") and three buttons. Choosing Live opens a confirmation that
says what happens next: "From the next hourly run, N people on the Pilot list and M
on the company-report list get real Slack messages. Anyone who has only had previews
gets the welcome message first." Choosing Off or Preview needs no confirmation.
The panel no longer says "Change SLACK_NOTIFY_MODE in Vercel".

### 2. A digests table says what happens next

The week line becomes a small table, one row per digest in play: the latest
complete week, last month's recap (when anyone has Monthly ticked), and the
previous period of each while it is still useful (shown until the next period
replaces it, so "sent to 41 of 43" stays visible for a while).

| Digest | Status | Next automatic send | Sent |
|---|---|---|---|
| Weekly 19–25 Oct | Ready | Next hourly run, from 10:30 in each person's own time zone, today (Mon 26 Oct) | — |
| Monthly September | Waiting for ChatGPT credits (through 30 Sep) | Any working day from the 3rd, once ready | — |
| Weekly 12–18 Oct | Sent | — | 41 of 43 on Tue 20 Oct |

Status wording, per row:

| State | Weekly | Monthly |
|---|---|---|
| Waiting | "Waiting for ChatGPT credits · Claude Team spend" | same, plus "Due from the 3rd" before the 3rd |
| Ready | "Ready" | "Ready" |
| Sent | "Sent" (count and date in the Sent column; failures named in a tooltip) | same |
| Skipped | "Not ready by Friday, so it won't go out by itself. You can still send it now." | n/a — a monthly waits all month |

*Builder's call (reviewer question 1):* "Next automatic send" describes what the
cron really does. The hourly run sends on any run where the digest is ready and it
is 10:30 or later in the recipient's time zone on a working day, so a week that
turns ready at 11:00 on Monday goes out at 11:30 Monday, not Tuesday. The day shown
is today when today is a working day, otherwise the next working day; for a monthly
before the 3rd it is the 3rd. A pure function with tests produces the day. In
preview mode the column adds "(preview: to the preview inbox)".

### 3. Send now

Each row has a Send now button, available in preview and live mode. In Off mode it
is disabled with "Choose Preview or Live first". It is also disabled when nobody has
that cadence ticked, and while a send is in progress.

Clicking opens a confirmation:

- Weekly, ready: "Send the weekly summary for 19–25 Oct now to 43 people (and the
  company report to 3)?"
- Weekly, not ready: the button reads **Send anyway** and the confirmation lists
  what is missing: "ChatGPT credits aren't imported past 11 Oct and Claude Team spend
  was last pasted 19 Oct. Figures for those will be incomplete. Send anyway?"
- Monthly, ready: "Send the September recap now to 43 people (and the company
  report to 3)?" A monthly that is not ready has no button, only its Waiting text.
- Preview mode: "…to the preview inbox (gareth.jones@…) as 43 preview messages."

**Behaviour**: a server action runs the same `runNotify` the cron uses, with options:
only this cadence and period; the 10:30 / working-day wait is skipped (today is the
send day, weekends included); and for the weekly, the readiness hold is bypassed.
Optionally a list of employee ids limits who is considered (used by part 6).
Everything else is identical: the mode, the Slack lookup, the claim in
`notification_sends` (which is what stops the hourly run from sending it again),
the first-message intro, the company report, the open-tracking link. The result
shown on the page: "Sent to 41. 2 failed: Adi Dahan (no Slack account), Clare
Edwards (Slack error)." Anyone not reached in the time budget is named, and a second
click sends only to them (the claims make this safe).

Send now records nothing extra; the "Last run" panel and the per-person "Last sent"
column show it like any run.

*Builder's calls (reviewer question 2):* Send now covers the periods the table
shows. A skipped week is reachable only over its weekend, which is the only time
the Skipped line is shown, so Send now must work on a Saturday or Sunday. Send now
stays enabled in the Sent state so people whose send failed can be retried; the
claims make a repeat click safe for everyone else.

### 4. Remove everyone

A **Remove everyone** link in the Pilot recipients header, with a confirmation:
"Remove all 43 people from the Pilot list? Their fixed-cost choices and send history
are kept, so adding them back restores them." It deletes every row of
`notification_subscriptions` and nothing else. The company-report and reminder lists
are untouched.

### 5. The intro after preview (lock, not a change)

A test on `runNotify` with the in-memory store: a person who received preview
messages and then gets a live weekly (via the Send now options) gets the intro;
the same person's next live message does not.

### 6. Catch-up for people added to the Pilot list

The Add person and Add team controls gain a checkbox, off by default: "Also send
them the latest weekly and monthly now". When ticked, after the people are added the
same Send now machinery runs limited to those people: the latest complete week for
those with Weekly ticked, and last month's recap for those with Monthly ticked, but
only if that monthly is ready. Anyone who already received a digest is skipped by
the claim, so ticking it for a half-enrolled team is safe. In Off mode the checkbox
is disabled with "choose Preview or Live first". Their first message opens with the
welcome as usual. The result is reported the same way as Send now.

### 7. Month-end reminders that land before the table resets

Claude Team's usage table resets at month end; a paste missed on the last working
day loses that month's figures for good. Today one reminder goes out at 15:00 on
the last working day, whether or not the paste has already been made.

New rule, all on the month's last working day in the recipient's own time zone, and
each one **only if the paste is still outstanding** (no Claude Team snapshot dated
that last working day or later):

| Time | Message |
|---|---|
| 09:30 | "Claude Team's table resets after today. Paste it before you finish." |
| 15:00 | the existing reminder, unchanged |
| 17:30 | "Still not pasted. After midnight October's figures can't be recovered." |

Once the paste is in, the later slots don't fire. Each slot is its own claim in the
send log (`report = 'reminder'`, cadence monthly, a period key that names the slot),
so the hourly run can never repeat one. The Monday reminder in the month's final
week gains a line: "Month-end paste for Claude Team is due on Fri 30 Oct."

Nothing fires on the 1st or later: by then the figures are gone.

## Tests

- Mode resolution: stored value wins; no row → env; junk → off.
- Next-send-day text: Monday (any time) → today; Saturday or Sunday → Monday.
- Mode guard: a stored "live" on a preview deployment resolves to the env var's
  value, not live.
- `runNotify` options: only the chosen cadence and period is due; the 10:30 wait is
  skipped; the weekly's readiness is bypassed, the monthly's is not; it works on a
  weekend; limited to given employees when asked; a second Send now sends nothing
  (all claimed); the cron run after a Send now sends nothing for that period.
- Digests table rows: which periods are shown, and each row's state and next-send
  text, for a Monday, a weekend, and the 1st and 3rd of a month.
- Catch-up on add: newly added people with Weekly get the latest week; those with
  Monthly get last month only when it is ready; people already sent are skipped.
- Month-end reminders: three slots on the last working day; none when the paste is
  already dated that day; none on the 1st; the Monday line appears only in the
  month's final week.
- Intro lock (part 5).
- Remove everyone empties the personal list and leaves the company list.
- The cron route refuses to run when the stored mode is off even if the env var says
  live (stored wins).

## Rollout

1. Apply migration 0026 to production.
2. Deploy. With no row stored, behaviour is unchanged (env var still rules).
3. On Data → Notifications, pick a mode. Suggested first use: stay in Preview, press
   Send now to see the whole flow land in the preview inbox, then switch to Live and
   press Send now for real (the preview claims don't block the live ones, because
   mode is part of the claim key).

## Left to the builder

- Exact component layout and placement of the buttons within the existing panels.
- The Send now action runs under the Data page's existing `maxDuration = 300`; the
  240 s budget in `runNotify` plus the "not reached, click again" path is the
  safety net.
- Whether the next-send-day helper lives in `week-status.ts` or `schedule.ts`.
- Deleting every row of a table through Supabase needs a filter; the builder picks
  one that is always true.
