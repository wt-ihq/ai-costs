# Slack Spend Digests

**Date:** 2026-09-30
**Status:** Approved design (pending step-0 checks, §10)

## Problem

The dashboard only helps people who open it. Most employees never see what
their AI use costs, and managers have no regular view of their org's spend.
We want Slack DMs that show people their own AI spend, and show managers
their reporting tree's spend, at a cadence each person chooses. The first
release is a hand-picked pilot.

## Decisions (agreed with Gareth)

1. **Purpose is mixed:** personal awareness, accountability for managers, and
   later anomaly alerts. This spec covers the **digests**. Alerts are a later
   slice on the same foundation.
2. **Pilot first.** Only people an admin has enrolled receive anything.
   Enrolment controls who *receives*, not whose spend is shown: a piloted
   manager's digest includes all their reports, enrolled or not.
3. **Leaders come from the Okta manager chain** (`profile.managerId`), not an
   admin mapping. A manager's digest covers their **whole reporting tree**
   (direct and indirect reports), even across Okta departments.
4. **Managers see named individuals:** the top 5 spenders by amount, then
   "+N others $X".
5. **Cadence is per recipient:** `daily`, `weekly`, `monthly`, any
   combination. Admins set it during the pilot; people will choose their own
   later (same table, new UI).
6. **Delivery:** DMs from a Slack bot. Built in-app with the Slack Web API
   (not Workflow Builder, not n8n), so the logic sits next to the data it
   needs.
7. **One message per recipient per cadence period**, with a "You" section
   and, for managers, a "Your reports" section. Someone on daily + weekly gets
   two DMs on a Monday (Sunday's daily and the week's recap), never two
   separate personal/manager DMs for the same period.
8. **A chart per section** (mockup option A): each section gets its own
   titled PNG chart directly under its headline. People without reports get
   only the "You" chart.
9. **Monthly recap window, 3rd–5th:** sent on the first morning from the 3rd
   when the month is ready; on the 5th regardless, with a caveat.
10. **Mode is an env var** (`off | preview | live`), shown read-only on the
    admin page. Going live takes a deliberate Vercel change.

## 1. Data model

Migration `0015_slack_notifications.sql`:

```sql
-- Raw Okta profile.managerId, stored as-is; resolved at read time (§2).
alter table employees add column if not exists manager_ref text;

create table notification_subscriptions (
  employee_id uuid not null references employees(id) on delete cascade,
  cadence     text not null check (cadence in ('daily','weekly','monthly')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (employee_id, cadence)
);

create table notification_sends (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  cadence     text not null,
  period_key  text not null,          -- '2026-09-29' | '2026-W39' | '2026-09'
  mode        text not null check (mode in ('preview','live')),
  status      text not null check (status in ('pending','sent','skipped','failed')),
  attempts    integer not null default 1,
  slack_ts    text,
  detail      text,                   -- skip/failure reason; never amounts or names
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (employee_id, cadence, period_key, mode)
);

create table slack_users (
  employee_id   uuid primary key references employees(id) on delete cascade,
  slack_user_id text,                 -- null = looked up, not found
  looked_up_at  timestamptz not null default now()
);
```

RLS on, grants to `service_role` only (same as every other table).

- **`notification_subscriptions` is the pilot allowlist.** No row means no
  message.
- **`notification_sends` is the send log and the idempotency guard.** A row
  is claimed (inserted as `pending`) *before* any Slack call. A unique
  conflict means "already handled", so skip. `mode` is part of the key, so a
  week of previews never counts as "already sent" once live.
- **`slack_users` caches `users.lookupByEmail`.** Kept separate from
  `employees` so the nightly Okta upsert (`upsertEmployees`, on `email`)
  never touches it. A not-found result (`slack_user_id = null`) is trusted
  for 7 days before looking up again.
- `normalizeOkta` adds `manager_ref: p.managerId?.toString().trim() || null`
  to `EmployeeUpsert`. If step 0 shows `managerId` refers to
  `employeeNumber`, `normalizeOkta` also stores `employee_number` so the
  reference can resolve.

None of these tables feed a `*Cached` reader, so no `FACTS_TAG` bust and no
`CACHE_VERSION` bump.

## 2. Reporting tree — `src/lib/notify/tree.ts` (pure)

```ts
export interface TreeEmployee {
  id: string; email: string; oktaId: string | null;
  managerRef: string | null; leaveDate: string | null;
}
export interface ReportingTree {
  /** All descendants (direct + indirect), never including the manager. */
  reportsOf(employeeId: string): string[];
  /** Active employees whose managerRef didn't resolve (for the admin card). */
  unresolved: string[];
}
export function buildReportingTree(employees: TreeEmployee[]): ReportingTree;
```

- `managerRef` is matched against the key the step-0 audit finds (Okta id,
  email, or employee number, compared case-insensitively). The match lives in
  this one function.
- **Cycle-safe:** the descendant walk keeps a visited set, and a self-reference
  (A manages A) is ignored.
- **Leavers stay in the tree** as descendants, so spend from before they left
  rolls up to their last manager. Leavers are never recipients.
- Resolved at read time from `fetchEmployeesAll`, never stored, so it always
  reflects the current roster.

## 3. Periods and schedule — `src/lib/notify/schedule.ts` (pure)

All windows are UTC and **exclusive-end** `[start, end)`, like the rest of the
codebase.

| Cadence | Period covered | Due on | `period_key` | Chart span |
|---|---|---|---|---|
| daily | yesterday | every run | `2026-09-29` | last 14 days |
| weekly | previous Mon–Sun | Mondays | `2026-W39` (ISO week) | last 8 weeks |
| monthly | previous calendar month | 3rd–5th, see below | `2026-09` | last 6 months |

```ts
export type Cadence = "daily" | "weekly" | "monthly";
export interface DigestPeriod {
  cadence: Cadence; key: string; label: string;   // "Tue 29 Sep" | "week of 21 Sep" | "September 2026"
  start: string; end: string;                      // the period
  prevStart: string; prevEnd: string;              // the comparison period
  buckets: { label: string; start: string; end: string }[]; // chart bars, oldest first
}
export function dueCadences(today: Date, monthlyReady: boolean): { cadence: Cadence; period: DigestPeriod; force?: boolean }[];
```

**Monthly readiness.** `monthToDate` (`run-all.ts`) re-syncs the previous
month through the 3rd, so the automatic sources aren't final before the
06:00 sync on the 3rd. The previous month is **ready** when:
- today is the 3rd or later, and
- `getImportCoverageScope` shows that month for every manual source that has
  facts in either of the two months before it (so a source the org stopped
  using can't block the recap).

On the 3rd or 4th, if not ready, wait. On the 5th, send regardless
(`force`); missing sources become caveats. The send log makes this safe: each
run tries the due period, and anyone already `sent` for `2026-09` is skipped.

## 4. Digest — `src/lib/notify/digest.ts` (pure)

```ts
export interface DigestSection {
  basis: "usage" | "total";
  headlineUsd: number; prevUsd: number; deltaPct: number | null; // null when prev = 0
  byTool: { key: string; label: string; color: string; usd: number }[]; // desc
  chart: { bucketLabel: string; byTool: Record<string, number>; current: boolean }[];
  monthSoFarUsd?: number;          // daily/weekly only: all cost types, MTD
  projectedMonthEndUsd?: number;   // daily/weekly only: projectPeriodEnd
}
export interface ReportsSection extends DigestSection {
  headcount: number;               // ACTIVE descendants; leavers' spend still counts in the figures
  top: { employeeId: string; name: string; team: string | null; usd: number }[]; // ≤ 5
  othersCount: number; othersUsd: number;
}
export interface Digest {
  recipient: { employeeId: string; name: string; team: string | null };
  period: DigestPeriod;
  you: DigestSection;
  reports?: ReportsSection;        // present iff the recipient has descendants
  caveats: string[];
  dashboardUrl: string;            // their Explore person page
}
export function buildDigest(input: {
  recipient; reportIds: string[]; facts: ShapeFact[]; period: DigestPeriod;
  now: Date; sourceHorizons: Record<string, string>; freshness: SourceFreshness[];
  employeesById: Map<string, { name: string; team: string | null }>; baseUrl: string;
}): Digest | null;                 // null = skip
```

Rules:
- **Headline basis.** Daily and weekly are **usage**: facts where
  `!isMonthlyLevelFact(f)` (`src/lib/explore/shape.ts`). That excludes seats,
  subscriptions *and* Claude Team's monthly usage lump, which all post as one
  monthly amount and would distort day/week comparisons. Monthly is the **total** (all cost
  types) and must equal Explore's month view for the same person to the cent.
  Charts follow the same basis.
- **Tool keys** use `vendorKeyOf` / `OTHER_KEY_PREFIX` and the dashboard
  colours (`VENDOR_COLORS`, `OTHER_TOOL_PALETTE` via the tool colour map), so
  names and colours match Explore. Amounts go through `formatUsd`.
- **Daily skip:** if yesterday's usage is $0 for the recipient *and* their
  whole tree, return `null` (logged as `skipped`, reason "no usage").
- **Top spenders** are sorted by amount only, with no peer ranking or
  judgement language ("high", "overspend").
- Person-less facts (department `subscription` rows, `unkeyed`) never appear
  in a "You" or "Reports" figure. They belong to no one.

**Caveats** — `src/lib/notify/freshness.ts` (pure) turns the latest
`sync_runs` per source, `getDataHealth`'s `latestDayByCostType`, and import
coverage into a `SourceFreshness[]`. `buildDigest` includes a caveat **only
for sources the recipient or their tree had spend with across the chart
span**:
- latest sync failed, or usage data doesn't reach the end of the period:
  "⚠ Cursor data may be incomplete (last updated 28 Sep)"
- monthly with a missing manual import:
  "⚠ ChatGPT Business seats for September aren't imported yet"

## 5. Rendering

**`src/lib/notify/render.ts` (pure)** turns a `Digest` into
`{ blocks, text }`:
- Header: "📊 Your AI spend · {period.label}"
- **You:** section label, headline line ("$38.20 usage · ▲ 12% vs previous
  week"), the "You" chart image block, context line ("September so far $142 ·
  on track for ~$190").
- **Your reports (N people)**, if present: headline, the reports chart,
  the top-5 line with names linked to Explore person pages, context line.
- Caveats as a context block, then an "Open in dashboard" button.
- `text`: a plain-text fallback carrying every headline figure. Slack uses it
  for push notifications and screen readers, and search uses only text.

**`src/lib/notify/chart.tsx`** is a `next/og` (`ImageResponse`, Satori)
component: stacked bars per bucket by tool, earlier buckets at 45% opacity,
the current bucket at full opacity with its total above, $ gridlines on its
own scale, a legend with the current period's split, and **the title drawn
into the image** ("YOU · USAGE, LAST 8 WEEKS" / "YOUR REPORTS (14 PEOPLE) ·
USAGE, LAST 8 WEEKS"), so it reads correctly opened full-screen. Satori
layout is flexbox-only, so the chart is built from plain boxes. `alt_text`
repeats the title and the headline.

**Images are never public.** The PNG is uploaded with
`files.getUploadURLExternal` → upload → `files.completeUploadExternal`, and
referenced from the image block by `slack_file` id (step 0 confirms this
works, §10). Block Kit `image_url` would need an unauthenticated public URL
of someone's spend, which is not acceptable.

**If a chart fails to render or upload, the digest is sent without that
image.** A chart is never a reason not to send.

## 6. Sending

**`src/lib/notify/slack-client.ts`** implements an injectable client (same
pattern as `ingest/sources/`). The token is a parameter; the only module
that reads `SLACK_BOT_TOKEN` from env is `src/lib/notify/wiring.ts`
(`import "server-only"`), which keeps the client unit-testable
(`server-only` doesn't resolve under vitest):

```ts
export interface SlackClient {
  lookupUserByEmail(email: string): Promise<string | null>;   // users.lookupByEmail
  openDm(userId: string): Promise<string>;                     // conversations.open
  uploadImage(png: Uint8Array, title: string): Promise<string>; // → file id
  postMessage(channel: string, blocks: unknown[], text: string): Promise<string>; // → ts
}
```

All calls check `ok`. `429` waits for `Retry-After`, up to 3 retries.

**`src/lib/notify/run-notify.ts`** is the orchestrator:

1. `mode === "off"` → return.
2. `dueCadences(today, monthlyReady)`. Nothing due → return.
3. If **no source has a successful `sync_runs` row today**, drop daily and
   weekly from the due list (no all-caveat messages). Monthly just tries again
   the next day.
4. Load subscriptions for the due cadences, keeping only active employees.
   None → return.
5. `fetchEmployeesAll` → `buildReportingTree`. **One** `fetchFactsInRange`
   covering the widest chart span among the due cadences, plus the current
   month for the MTD/projection line. Facts are split per recipient in
   memory.
6. For each (recipient, cadence), **isolated** (one failure never stops the
   rest):
   1. Claim: insert a `pending` send row. On conflict: if the existing row is
      `failed`, the period is still due and `attempts < 3`, take it over
      (`attempts + 1`); otherwise skip. (In practice, retries matter for the
      monthly 3rd–5th window and for manual same-day re-runs. A daily period
      is only due on its own day.)
   2. `buildDigest`. `null` → `skipped`.
   3. Resolve the Slack user (cache, then lookup). None → `failed: no Slack
      account`.
   4. Render the charts and upload them (best effort), `render`, `openDm`,
      `postMessage`. **Mark `sent` with `slack_ts` right after the post
      returns.**
7. **Time budget:** stop starting new recipients at ~240 s of the 300 s
   `maxDuration`. The ones not reached are counted in the result and left
   unclaimed.
8. Return `{ due, sent, skipped, failed, notReached }`. Log counts and
   employee IDs only.

**Stale `pending` rows** (older than 10 minutes, meaning the run crashed
between claiming and marking) become `failed: interrupted` and are **not
retried**. We can't tell whether the DM went out, and never sending twice
matters more than always sending once.

**Preview mode:** everything is identical, except the DM goes to
`SLACK_PREVIEW_EMAIL`'s Slack user, the header is prefixed "Would send to
{name} ({cadence})", and rows are written with `mode = 'preview'`.

**Route:** `src/app/api/cron/notify/route.ts`: `isCronAuthorized` (fails
closed), `dynamic = "force-dynamic"`, `maxDuration = 300`, optional `?date=`
override (acts as "today", for replaying a day in preview). Added to
`vercel.json` at `0 7 * * *` (08:00 UK summer time, one hour after the sync).

**Env:** `SLACK_BOT_TOKEN` (secret), `SLACK_NOTIFY_MODE` (defaults to `off`
when unset), `SLACK_PREVIEW_EMAIL`. Base URL for links:
`VERCEL_PROJECT_PRODUCTION_URL`.

## 7. Admin page — Data → Notifications

A new admin-only tab (`admin: true` in `TABS`, `data/notifications-tab.tsx`),
as mocked:

- **Status cards:** Mode (read-only badge + where to change it), Last run
  (sent / skipped / failed, which cadences were due), Manager chain (N/M
  active people resolved, a "view" list of unresolved people).
- **Pilot recipients:** add a person (search), add a team (an Okta
  `department`; adds its current active members once, so later joiners are
  not auto-enrolled), and the default cadences for newly added people. Per row:
  daily/weekly/monthly checkboxes (save on click), report count from the tree,
  Slack status (found / not found / not yet looked up), last sent, a "left"
  badge for leavers, remove, Preview.
- **Preview panel:** pick a cadence and step through periods. It renders
  exactly what the cron would send by calling the same `buildDigest` and
  `render`, shown as a Slack-style card with both charts. **"Send this to
  me in Slack"** DMs it to the signed-in admin. It's never logged as a send
  and never goes to the recipient.
- **Recent sends:** the last 50 `notification_sends` rows with status and
  detail.

Every Server Action (`addRecipients`, `setCadence`, `removeRecipient`,
`sendPreviewToMe`) starts with `await requireAdmin()`. `sendPreviewToMe`
targets the session's own email, never an argument.

## 8. Security and PII

- The bot token lives only in Vercel env and is read only by `notify/wiring.ts` (`server-only`).
- A manager's digest contains only people in their own tree (data
  minimisation). Personal sections contain only the recipient's own spend.
- Server logs and `notification_sends.detail` never contain names or amounts.
- The Slack app manifest (`docs/slack-app-manifest.yml`) requests only
  `chat:write`, `users:read`, `users:read.email`, `im:write`, `files:write`.
- Known, accepted: dashboard links go to Explore, which any `@intenthq.com`
  viewer can already open in full. This must be revisited before the full
  rollout, since that will bring many new viewers.

## 9. Testing (vitest, TDD)

- **tree:** multi-level descendants; cycles (A→B→A) terminate; a
  self-manager is ignored; unresolvable refs are listed in `unresolved`;
  leavers are included as descendants; the manager is never in their own
  list.
- **schedule:** Monday → daily + weekly; the 1st–2nd → no monthly; the 3rd
  ready → monthly; the 3rd not ready → none; the 5th → monthly `force`; ISO
  week keys across a year boundary; exclusive-end windows.
- **freshness / caveats:** a failed sync → caveat only for recipients using
  that source; a missing import → monthly caveat; unused sources → no
  caveat.
- **digest:** daily/weekly headline = usage only; **monthly total = the sum of
  that person's facts to the cent**; top-5 + others add up to the tree total;
  daily `null` when there's no usage anywhere; person-less facts excluded;
  deltaPct `null` on a zero base.
- **render:** a Block Kit snapshot for a manager and an IC; the `text`
  fallback contains every headline figure; the chart title matches its
  section.
- **run-notify** (fake `SlackClient` + fake DB): a second run sends nothing;
  preview redirects and writes `mode = 'preview'`; one recipient throwing
  doesn't stop the others; a failed row is retried ≤3 times; a stale
  `pending` → `failed: interrupted`, not resent; the time budget stops new
  claims; a chart upload failure still sends text.
- **Manual check (gotcha #2):** for 3 pilot people, the preview's monthly
  figures equal their Explore person page for the same month.

`npm run test` and `CI=true npm run build` before every commit.

## 10. Step 0: checks before feature code

1. **Okta manager audit:** once migration 0015 and the normalizer change
   are live and an Okta sync has stored `manager_ref`, run an
   **aggregates-only** SQL query: the share of active users with a ref, its
   format distribution (email-like / `00u…` / numeric), and the share that
   resolves to an employee. (This replaces a throwaway debug route: the
   Okta token only exists in Vercel, so either way needs the field shipped
   first.) **If well under ~80% resolves, stop and revisit Decision 3 with
   Gareth** (fallback: admin-assigned managers).
2. **Slack private image:** confirm that an uploaded PNG referenced by
   `slack_file` id renders in a bot DM. Fallback: attach both charts to the
   DM as files (still private, but they sit together below the text instead
   of under each section).

**Status (2026-10-01):** Code shipped on branch `slack-digests` with inline
`slack_file` chart images assumed. Checkpoint A (production migration 0015 +
Okta manager audit) and Checkpoint B (Slack app + `scripts/slack-smoke.ts`)
are pending Gareth; if B fails, the fallback touches `slack-client.ts`
`uploadImage` and `deliver.ts`, and the admin preview
(`block-kit-preview.tsx` / `notifications-tab.tsx`) must also stop showing
inline charts so it keeps matching what is sent.

## 11. Rollout

1. Ship with `SLACK_NOTIFY_MODE` unset (= `off`).
2. Run the step-0 checks.
3. Gareth creates and installs the Slack app from the manifest and sets
   `SLACK_BOT_TOKEN`, `SLACK_NOTIFY_MODE=preview`, `SLACK_PREVIEW_EMAIL`.
4. Enrol pilot recipients and review a week of previews.
5. Switch to `live` for the pilot, and add a plain-language CHANGELOG entry.

## Out of scope

Self-serve preferences UI, anomaly alerts, channel posts, batching or queueing
for a full rollout (~250 people won't fit the 300 s budget), per-person
timezones, and Slack interactivity beyond the link button.
