# Notification Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin switch the Slack digest mode, see each weekly/monthly digest's status and next send, send one now, empty the pilot list, catch up newly added people, and get month-end Claude Team reminders that land before the table resets.

**Architecture:** The mode moves from a Vercel env var to one row in a new `notification_config` table, read through one resolver. "Send now" and "catch-up" are the existing `runNotify` with a new `only` option (one cadence + period, no 10:30 wait, optional forced readiness, optional employee filter), so claims, intros and the company report behave exactly as in the cron. Status rows come from a new pure module fed by the existing readiness helpers. Month-end reminders become three slots on the last working day, each skipped once the paste is in.

**Tech Stack:** Next.js 16 App Router (server actions, client components), TypeScript, Supabase (PostgREST), vitest. Existing notify code in `src/lib/notify/`.

**Spec:** `docs/superpowers/specs/2026-10-26-notification-controls-design.md`

## Global Constraints

- Every `"use server"` action starts with `await requireAdmin()` (`src/lib/auth-guard.ts`).
- Send log is claim-before-send; never make a row retryable once a DM may have gone out. `mode` and `report` stay part of `SendKey`.
- Secrets stay in Vercel env; `SLACK_BOT_TOKEN` is read only in `notify/wiring.ts`.
- Mode values are exactly `off | preview | live` (`NotifyMode` in `types.ts`).
- Stored mode is honoured only when `process.env.VERCEL_ENV === "production"` or `NODE_ENV === "development"`; otherwise the env var alone decides.
- Copy is plain English; every user-facing string in the spec's tables is used verbatim.
- Migration `0026_notification_config.sql` must be applied to production before deploy (note it in CLAUDE.md).
- A changelog entry in `src/lib/changelog.ts` (newest first, plain language).
- Commit after each task; messages end with `Co-Authored-By: Claude Fable 5.1 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. Send now while the hourly cron is mid-run: a `pending` row for the same (person, cadence, period, mode, report) must block Send now for that person (claim conflict), never double-send. → Task 3 test "a pending claim blocks send-now for that person".
2. Preview mode with `SLACK_PREVIEW_EMAIL` not matching an employee: Send now must return an error message, not throw out of the action. → Task 4 test.
3. A stored mode row with a junk value (or a row on a preview deployment): must resolve to the env var, never to live. → Task 1 tests.
4. Monthly Send now when the month isn't ready or before the 3rd: the action refuses with the Waiting text and sends nothing. → Task 4 test.
5. The month's last working day falling on a Monday: the weekly reminder and all three month-end slots are due, each claimed separately. → Task 9 test.

---

### Task 1: Mode stored in the database

**Files:**
- Create: `supabase/migrations/0026_notification_config.sql`
- Create: `src/lib/notify/mode-store.ts`
- Modify: `src/lib/notify/types.ts` (next to `notifyMode`)
- Modify: `src/app/api/cron/notify/route.ts:28-30`
- Test: `src/lib/notify/types.test.ts`, `src/lib/notify/mode-store.test.ts`

**Interfaces:**
- Produces: `resolveNotifyMode(stored: string | null, env: Record<string, string | undefined>): NotifyMode` in `types.ts`. Rule: if `env.VERCEL_ENV === "production" || env.NODE_ENV === "development"` and `stored` is `preview`/`live`/`off`, return it; otherwise return `notifyMode(env)`.
- Produces: `readStoredMode(supabase): Promise<string | null>` (row `key='mode'`, `null` when absent), `writeStoredMode(supabase, mode: NotifyMode, updatedBy: string): Promise<void>` (upsert on `key`), `currentMode(supabase): Promise<NotifyMode>` = `resolveNotifyMode(await readStoredMode(supabase), process.env)` in `mode-store.ts`.

- [ ] **Step 1: Write the failing tests for the resolver** in `types.test.ts`

```ts
describe("resolveNotifyMode", () => {
  const prod = { VERCEL_ENV: "production", SLACK_NOTIFY_MODE: "preview" };
  it("stored value wins on production", () => expect(resolveNotifyMode("live", prod)).toBe("live"));
  it("no row → env var", () => expect(resolveNotifyMode(null, prod)).toBe("preview"));
  it("junk row → env var", () => expect(resolveNotifyMode("LIVE!", prod)).toBe("preview"));
  it("stored live on a preview deployment → env var", () => expect(resolveNotifyMode("live", { VERCEL_ENV: "preview", SLACK_NOTIFY_MODE: "off" })).toBe("off"));
  it("stored value wins in local development", () => expect(resolveNotifyMode("live", { NODE_ENV: "development" })).toBe("live"));
  it("nothing anywhere → off", () => expect(resolveNotifyMode(null, {})).toBe("off"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/notify/types.test.ts`
Expected: FAIL, `resolveNotifyMode` is not exported.

- [ ] **Step 3: Implement `resolveNotifyMode` in `types.ts`** (reuse `notifyMode` for the fallback).

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Write the migration** `0026_notification_config.sql`:

```sql
-- Slack digest mode chosen on Data → Notifications (docs/superpowers/specs/2026-10-26-notification-controls-design.md).
-- One row, key 'mode', value off|preview|live. No row = SLACK_NOTIFY_MODE decides. Apply BEFORE deploying.
create table notification_config (
  key        text primary key,
  value      text not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
alter table notification_config enable row level security;
grant all on public.notification_config to service_role;
```

- [ ] **Step 6: Write the failing test for `mode-store.ts`** with a fake Supabase client (pattern: `run-vercel.test.ts:fakeVercelDb`): `readStoredMode` returns null with no row and the value with one; `writeStoredMode` upserts `{ key: "mode", value, updated_by, updated_at }` with `onConflict: "key"`; `currentMode` with a stored "live" and `process.env.VERCEL_ENV` stubbed to "production" returns "live".

- [ ] **Step 7: Run to verify it fails; implement `mode-store.ts`; run to verify it passes.**

- [ ] **Step 8: Use it in the cron route.** Replace `const mode = notifyMode();` with `const mode = await currentMode(getSupabaseAdminClient());` (build the client once, reuse it for the store). The "off" response text becomes `"mode is off"`.

- [ ] **Step 9: Run the full suite, lint; commit**

```bash
git commit -m "feat(notify): digest mode stored in notification_config, env var as fallback"
```

---

### Task 2: Mode panel on Data → Notifications

**Files:**
- Create: `src/components/notifications/mode-panel.tsx` (client)
- Modify: `src/app/(dashboard)/data/notifications-actions.ts` (new action)
- Modify: `src/app/(dashboard)/data/notifications-tab.tsx:143,171-180`
- Modify: `src/lib/notify/admin-store.ts` (`NotificationsAdminData`, `loadNotificationsAdmin`, `loadStatus`)
- Test: `src/app/(dashboard)/data/notifications-actions.test.ts` if one exists, else `src/lib/notify/mode-store.test.ts` covers the store; the action is a thin wrapper.

**Interfaces:**
- Produces: `setNotifyMode(mode: string): Promise<void>` server action: `requireAdmin`, validate `mode` is a `NotifyMode` (else throw "Invalid mode"), `writeStoredMode(getSupabaseAdminClient(), mode, await actorEmail())`, `revalidatePath("/data")`.
- Produces: `NotificationsAdminData.mode: NotifyMode` and `NotificationsAdminData.modeSource: "page" | "env"` (whether a stored row decided it). `loadStatus` takes `mode` as a parameter instead of calling `notifyMode()`.
- Produces: `ModePanel({ mode, modeSource, previewEmail, pilotCount, companyCount }: { mode: NotifyMode; modeSource: "page" | "env"; previewEmail: string | null; pilotCount: number; companyCount: number })`.

- [ ] **Step 1: Add `mode`/`modeSource` to `loadNotificationsAdmin`** (read `readStoredMode` alongside the other reads; `mode = resolveNotifyMode(stored, process.env)`; `modeSource = stored !== null && mode === stored ? "page" : "env"`). Pass `mode === "preview" ? "preview" : "live"` into `loadStatus`.

- [ ] **Step 2: Write the action `setNotifyMode`** in `notifications-actions.ts`.

- [ ] **Step 3: Build `ModePanel`**. Three buttons (Off / Preview / Live), current one highlighted. Copy:
  - off: "Off: nothing is sent."
  - preview: "Preview: every message goes to {previewEmail}, nobody else." (previewEmail null → "the preview inbox (SLACK_PREVIEW_EMAIL is not set)")
  - live: "Live: messages go to the people on the lists."
  - modeSource "env": a muted line "Set by the Vercel variable until you pick one here."
  - Choosing Live: `window.confirm` with "From the next hourly run, {pilotCount} people on the Pilot list and {companyCount} on the company-report list get real Slack messages. Anyone who has only had previews gets the welcome message first. Switch to Live?" Off/Preview: no confirm.
  - Use `useTransition`; show errors like `RecipientsTable` does.

- [ ] **Step 4: Replace the Mode `<Panel>` in `notifications-tab.tsx`** with `<ModePanel …/>`; delete the `notifyMode()` call at line 143 and use `data.mode`. Remove the sentence "Change SLACK_NOTIFY_MODE in Vercel".

- [ ] **Step 5: `npm run lint`, `CI=true npm run build`, run the suite; commit**

```bash
git commit -m "feat(notify): choose off/preview/live on Data → Notifications"
```

---

### Task 3: `runNotify` learns `only` (one digest, now, optional force, optional people)

**Files:**
- Modify: `src/lib/notify/run-notify.ts` (`RunNotifyDeps`, `RunNotifyResult`, steps 1–3, `sendOne` callers)
- Modify: `src/lib/notify/memory-store.ts` only if a seed helper is needed
- Test: `src/lib/notify/run-notify.test.ts`

**Interfaces:**
- Produces on `RunNotifyDeps`:
  ```ts
  /** Send one digest now (Data → Notifications "Send now" / catch-up): this cadence and period only, today is
   *  the send day for everyone (no 10:30 wait, weekends included), optionally forced past the readiness hold,
   *  optionally limited to these people. The claim key is unchanged, so the cron sees it as handled. */
  only?: { cadence: Cadence; periodKey: string; force?: boolean; employeeIds?: string[] };
  ```
- Produces on `RunNotifyResult`: `people: { employeeId: string; report: ReportKind; status: "sent" | "skipped" | "failed" | "alreadyHandled" | "notReached"; detail?: string }[]` — one entry per (recipient, report) considered this run (always filled, not only with `only`).
- Behaviour with `only`: candidates are those with `sub.cadence === only.cadence` (and `employeeIds` when given); `day = now.toISOString().slice(0,10)` regardless of time zone or working day; due = `[periodFor(only.cadence, only.periodKey, now)]` when `only.cadence === "daily"`, or `only.cadence === "weekly" && (only.force || weekReady)`, or `only.cadence === "monthly" && monthReady` (readiness computed as today for that period; `inMonthlyWindow` is not applied); otherwise due is empty and `held` names it. No daily is added.

- [ ] **Step 1: Write the failing tests**

```ts
describe("runNotify only", () => {
  const SAT = new Date("2026-10-03T14:00:00Z");
  it("sends the named week to weekly subscribers now, on a Saturday, and the next cron run skips it", async () => {
    const store = memoryStore(seed({ syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-09-28T06:00:03Z" }] }), () => SAT.getTime());
    const slack = fakeSlack();
    const r = await runNotify(deps(store, slack.client, { now: SAT, clock: () => SAT.getTime(), only: { cadence: "weekly", periodKey: "2026-W39" } }));
    expect(r).toMatchObject({ due: ["weekly:2026-W39"], sent: 1 });
    expect(r.people).toEqual([{ employeeId: "m", report: "personal", status: "sent" }]);
    const cron = await runNotify(deps(store, slack.client));
    expect(cron.sent).toBe(0); // Monday's run finds W39 handled for m
  });
  it("holds a weekly that isn't ready unless forced", async () => {
    const store = memoryStore(seed({ syncRuns: [] }), () => SAT.getTime());
    const held = await runNotify(deps(store, fakeSlack().client, { now: SAT, only: { cadence: "weekly", periodKey: "2026-W39" } }));
    expect(held).toMatchObject({ sent: 0, held: ["weekly:2026-W39"] });
    const forced = await runNotify(deps(store, fakeSlack().client, { now: SAT, only: { cadence: "weekly", periodKey: "2026-W39", force: true } }));
    expect(forced.sent).toBe(1);
  });
  it("never forces a monthly", …) // force: true, coverage incomplete → sent 0, held ["monthly:2026-09"]
  it("limits to the given people", …) // employeeIds: ["m"] with another weekly subscriber present → only m sent
  it("a pending claim blocks send-now for that person", …) // seed sends: m/weekly/2026-W39/live/personal pending (updatedAt = now) → sent 0, people[0].status "alreadyHandled"
  it("sends the company report too", …) // companyRecipients [{ c, weekly }] → people has { c, "company", "sent" }
});
```

- [ ] **Step 2: Run to verify they fail** (`only` ignored → wrong counts / `people` undefined).

- [ ] **Step 3: Implement.** In step 1 skip the `sendDay` call when `only` (day = now's date); in step 2 build `dueByDay` from `only` as specified instead of `dueDigests`; in step 3 push to `result.people` wherever `alreadyHandled`, `notReached`, the no-Slack path and `sendOne` outcomes are counted. Keep every existing test green.

- [ ] **Step 4: Run `src/lib/notify` tests; commit**

```bash
git commit -m "feat(notify): runNotify can send one digest now (only), reporting per-person outcomes"
```

---

### Task 4: `sendNow` and the `sendDigestNow` action

**Files:**
- Create: `src/lib/notify/send-now.ts`
- Modify: `src/app/(dashboard)/data/notifications-actions.ts`
- Test: `src/lib/notify/send-now.test.ts`

**Interfaces:**
- Produces: `sendNow(deps: Omit<RunNotifyDeps, "only" | "replay" | "mode"> & { mode: NotifyMode }, req: { cadence: Cadence; periodKey: string; force?: boolean; employeeIds?: string[] }): Promise<SendNowResult>` where
  ```ts
  export type SendNowResult =
    | { ok: true; sent: number; alreadyHandled: number; failed: { name: string; detail: string }[]; notReached: string[]; held: string | null }
    | { ok: false; error: string };
  ```
  Rules: `mode === "off"` → `{ ok: false, error: "Choose Preview or Live first" }`; `cadence === "monthly" && force` → force ignored; `cadence === "daily"` → `{ ok: false, error: "Only weekly and monthly digests can be sent now" }`; `held` is the spec's Waiting text when nothing was due (readiness not met). Names come from `store.employees()`. Any thrown error → `{ ok: false, error }`.
- Produces: server action `sendDigestNow(cadence: string, periodKey: string, force: boolean): Promise<SendNowResult>`: `requireAdmin`, validate (`isCadence`, `periodFor` parses the key, boolean), build deps like `sendTestDigest` does plus `renderBanner: renderWelcomeBannerPng`, `mode: await currentMode(supabase)`, `previewEmail: process.env.SLACK_PREVIEW_EMAIL ?? null`, `now: new Date()`; `revalidatePath("/data")` after.

- [ ] **Step 1: Write the failing tests** (memory store + fakeSlack as in `run-notify.test.ts`): off mode → error; preview mode with no matching preview email → `{ ok: false, error: "SLACK_PREVIEW_EMAIL does not match an employee" }`; weekly ready → `ok, sent 1, failed []`; monthly not ready with `force: true` → `ok, sent 0, held` text starting "Waiting for"; a person whose Slack lookup returns null → `failed: [{ name: "Person m", detail: "no Slack account" }]`.

- [ ] **Step 2: Run to verify they fail; implement `send-now.ts`; run to verify they pass.**

- [ ] **Step 3: Add `sendDigestNow` to `notifications-actions.ts`.**

- [ ] **Step 4: Lint, suite; commit**

```bash
git commit -m "feat(notify): Send now action for a weekly or monthly digest"
```

---

### Task 5: Digest status rows (pure) and the loader

**Files:**
- Create: `src/lib/notify/digest-status.ts`
- Modify: `src/lib/notify/store.ts` (`sendStates` rows gain `updatedAt: string`), `src/lib/notify/memory-store.ts` (same)
- Modify: `src/lib/notify/admin-store.ts:loadStatus` and `NotificationsAdminData` (replace `weekStatus`/`monthStatus` with `digests: DigestStatusRow[]`)
- Delete: `src/lib/notify/week-status.ts` + its test once nothing imports them
- Test: `src/lib/notify/digest-status.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DigestStatusRow {
    cadence: "weekly" | "monthly";
    periodKey: string;
    label: string;                     // "Weekly 19–25 Oct 2026" / "Monthly September 2026"
    state: "waiting" | "ready" | "sent" | "skipped";
    statusText: string;                // spec §2 table, verbatim
    nextSend: string | null;           // "Next hourly run, from 10:30 in each person's own time zone, today (Mon 26 Oct)" …; null when sent
    sentText: string | null;           // "41 of 43 on Tue 20 Oct"
    recipients: number;                // personal + company with this cadence
    sendNow: { label: "Send now" | "Send anyway"; confirm: string } | null; // null = no button (monthly not ready)
    missing: string[];                 // outstanding items, for the Send anyway confirmation
  }
  export function nextAutomaticSendDay(today: string, cadence: "weekly" | "monthly"): string;
  export function digestStatusRows(i: {
    today: string; mode: NotifyMode; previewEmail: string | null;
    periods: { cadence: "weekly" | "monthly"; period: DigestPeriod; readiness: { ready: boolean; missing: string[] }; recipients: { personal: number; company: number }; sends: { status: string; updatedAt: string }[] }[];
  }): DigestStatusRow[];
  ```
  `nextAutomaticSendDay`: weekly → today if `isWorkingDay(today)` else next working day; monthly → the later of that and the 3rd of today's month. Rows are ordered: latest week, latest month, previous week (only if it has sends), previous month (only if it has sends). Skipped = weekly whose Friday after the week is before today and nothing sent. Preview mode appends " (preview: to the preview inbox)" to `nextSend`. The confirm strings are the spec §3 texts.

- [ ] **Step 1: Write the failing tests** for `nextAutomaticSendDay` (Mon 2026-10-26 → same; Sat 2026-10-31 → 2026-11-02; monthly on 2026-11-01 → 2026-11-03) and for `digestStatusRows` on: a Monday with the week ready and the month waiting (two rows, texts verbatim); a Saturday after Friday with nothing sent (skipped row with "Send anyway"); a week fully sent (sentText "41 of 43 on Tue 20 Oct", nextSend null, sendNow still present with label "Send now"); previous week shown only when it has sends.

- [ ] **Step 2: Run to verify they fail; implement `digest-status.ts`; run to verify they pass.**

- [ ] **Step 3: Add `updatedAt` to `sendStates`** rows in both stores (`updated_at` column already read in `admin-store`; add it to the store's select). Run the store tests.

- [ ] **Step 4: Rewrite `loadStatus`** to compute readiness for the latest and previous week (`stepKey("weekly", key, -1, now)`) and latest and previous month, then call `digestStatusRows`. Delete `week-status.ts` and its test; update `NotificationsAdminData` and every reader (`notifications-tab.tsx` compiles only after Task 6; do Tasks 5 and 6 in one commit if the build must stay green between them).

- [ ] **Step 5: Suite; commit (with Task 6 if needed)**

---

### Task 6: Digests table with Send now

**Files:**
- Create: `src/components/notifications/digests-table.tsx` (client)
- Modify: `src/app/(dashboard)/data/notifications-tab.tsx:159-170`

**Interfaces:**
- Consumes: `DigestStatusRow[]`, `sendDigestNow` (Task 4), `NotifyMode`.
- Produces: `DigestsTable({ rows, mode }: { rows: DigestStatusRow[]; mode: NotifyMode })`.

- [ ] **Step 1: Build the table**: columns Digest · Status · Next automatic send · Sent · (button). Button disabled when `mode === "off"` (title "Choose Preview or Live first"), when `row.recipients === 0`, or while pending. Click → `window.confirm(row.sendNow.confirm)` → `sendDigestNow(row.cadence, row.periodKey, row.sendNow.label === "Send anyway")`. Result line under the table: "Sent to {sent}." then ", {n} failed: {name} ({detail})…" and, when `notReached.length`, "Not reached in time: {names}. Click Send now again to send to them." Errors shown in the pink error style.

- [ ] **Step 2: Replace the week `<Panel>`** in `notifications-tab.tsx` with a full-width `<Panel>` holding `<DigestsTable rows={data.digests} mode={data.mode} />`.

- [ ] **Step 3: Lint, `CI=true npm run build`, suite; commit**

```bash
git commit -m "feat(notify): digests table with status, next send and Send now"
```

---

### Task 7: Remove everyone

**Files:**
- Modify: `src/lib/notify/admin-store.ts` (after `removeSubscriptions`)
- Modify: `src/app/(dashboard)/data/notifications-actions.ts`
- Modify: `src/components/notifications/recipients-table.tsx` (header controls)
- Test: `src/lib/notify/admin-store.test.ts`

**Interfaces:**
- Produces: `removeAllSubscriptions(supabase, report: ReportKind = "personal"): Promise<number>` — deletes every row of `RECIPIENT_TABLE[report]` (`.delete().neq("cadence", "")` as the always-true filter, `.select("employee_id")` to count); returns the count.
- Produces: action `removeAllRecipients(): Promise<{ removed: number }>`.

- [ ] **Step 1: Write the failing test**: a fake client records the delete chain; `removeAllSubscriptions` hits `notification_subscriptions` only and returns the row count; a second call on an empty table returns 0 without error.

- [ ] **Step 2: Run to verify it fails; implement; run to verify it passes.**

- [ ] **Step 3: Action + UI.** A "Remove everyone" link at the right of the add-controls row, muted, hover pink; `window.confirm("Remove all {n} people from the Pilot list? Their fixed-cost choices and send history are kept, so adding them back restores them.")`. Hidden when `rows.length === 0`.

- [ ] **Step 4: Lint, suite; commit**

```bash
git commit -m "feat(notify): Remove everyone from the Pilot list"
```

---

### Task 8: Catch-up for people added to the Pilot list

**Files:**
- Modify: `src/app/(dashboard)/data/notifications-actions.ts` (`addRecipients`, `addTeamRecipients`)
- Modify: `src/components/notifications/recipients-table.tsx` (checkbox + result line)
- Test: `src/lib/notify/send-now.test.ts` (catch-up helper)

**Interfaces:**
- Produces in `send-now.ts`: `catchUp(deps, employeeIds: string[], now: Date): Promise<SendNowResult>` — runs `sendNow` for `{ cadence: "weekly", periodKey: latestCompleteKey("weekly", now), employeeIds }` then for `{ cadence: "monthly", periodKey: latestCompleteKey("monthly", now), employeeIds }` (monthly never forced; a held monthly is not an error), merging the two results (sums, concatenated failures; `held` from the monthly when the weekly went).
- Produces: `addRecipients(employeeIds, cadences, catchUp = false): Promise<{ added: number; catchUp?: SendNowResult }>` and `addTeamRecipients(department, cadences, catchUp = false)` likewise. With `catchUp`, after adding, call `catchUp(...)` with the added people's ids (team: the members' ids).

- [ ] **Step 1: Write the failing test** for `catchUp`: two new people, weekly ready, month not ready → weekly sent 2, monthly held, `ok: true`; a person who already had that week → `alreadyHandled` 1, sent 1.

- [ ] **Step 2: Run to verify it fails; implement; run to verify it passes.**

- [ ] **Step 3: Actions + UI.** Checkbox "Also send them the latest weekly and monthly now" after the cadence defaults, off by default, disabled with title "choose Preview or Live first" when `mode === "off"` (pass `mode` into `RecipientsTable`). After Add / Add team with it ticked, show the same result line as the digests table.

- [ ] **Step 4: Lint, suite, build; commit**

```bash
git commit -m "feat(notify): send new recipients the latest weekly and monthly on add"
```

---

### Task 9: Month-end reminders in three slots, skipped once pasted

**Files:**
- Modify: `src/lib/notify/schedule.ts` (`DueReminder`, `dueReminders`, constants)
- Modify: `src/lib/notify/reminders.ts` (`monthEndReminder`, `WeeklyReminderInput`)
- Modify: `src/lib/notify/run-reminders.ts`
- Test: `src/lib/notify/schedule.test.ts`, `src/lib/notify/reminders.test.ts`, `src/lib/notify/run-reminders.test.ts`

**Interfaces:**
- Produces: `MONTH_END_SLOTS = [{ slot: "morning", at: 9*60+30, keySuffix: ":0930" }, { slot: "afternoon", at: 15*60, keySuffix: "" }, { slot: "lastCall", at: 17*60+30, keySuffix: ":1730" }] as const`; `DueReminder` gains `slot?: "morning" | "afternoon" | "lastCall"` for `kind: "monthEnd"`, with `periodKey = month + keySuffix` (the afternoon keeps today's bare month key, so existing claims still match).
- Produces: `monthEndReminder(i: { monthName: string; importsUrl: string; slot: "morning" | "afternoon" | "lastCall" })` with copy: morning header "Claude Team's table resets after today", body "Paste it before you finish. …"; afternoon unchanged; lastCall header "Still not pasted", body "After midnight {monthName}'s figures can't be recovered." Each keeps the Imports button.
- Produces: `WeeklyReminderInput.monthEndDue: string | null` (a day, e.g. "2026-10-30"); when set, `weeklyReminder` appends the line "Month-end paste for Claude Team is due on Fri 30 Oct." (weekday short name + `d()`).
- Behaviour in `run-reminders.ts`: for each month-end reminder, before claiming, `store.manualImports(lastWorkingDay)` → if any row has `source === "claude_team"` and `dataAsOf >= reminder.day`, count it in a new `result.skipped` and don't claim. For the weekly reminder, `monthEndDue = lastWorkingDay(month of day)` when it is within `[day, day+6]`, else null.

- [ ] **Step 1: Write the failing tests** in `schedule.test.ts`: on 2026-10-30 (Friday) at 09:35 London → one monthEnd morning reminder with key "2026-10:0930"; at 15:05 → morning + afternoon ("2026-10"); at 17:35 → all three; on 2026-11-02 (Monday, last working day of Nov is 30th) → only the weekly; **Review Focus 5**: 2026-11-30 is a Monday → at 17:35 the weekly plus three month-end slots, four distinct period keys.

- [ ] **Step 2: Run to verify fail; implement in `schedule.ts`; run to verify pass.**

- [ ] **Step 3: Write the failing tests** in `reminders.test.ts` for the three slots' copy and the weekly line; implement; verify.

- [ ] **Step 4: Write the failing tests** in `run-reminders.test.ts`: paste already dated the last working day → `skipped` 1, no send, no claim; not pasted → sent; weekly in the final week carries the month-end line; implement; verify.

- [ ] **Step 5: Suite; commit**

```bash
git commit -m "feat(notify): month-end Claude Team reminders at 09:30, 15:00 and 17:30, skipped once pasted"
```

---

### Task 10: Intro-after-preview lock, docs, changelog

**Files:**
- Test: `src/lib/notify/run-notify.test.ts`
- Modify: `src/lib/changelog.ts`, `CLAUDE.md` (Slack digests paragraph)

- [ ] **Step 1: Write the lock test** (it should pass immediately; it is a regression lock, say so in a comment): seed sends with `m/weekly/2026-W38/preview/personal` sent; run `only` weekly W39 in live mode → the post's blocks include the intro (first block text contains "Hi Person"); run again for W40 → no intro.

- [ ] **Step 2: Changelog entry** dated 2026-10-26 (append to the existing 2026-10-26 entry's items if present), plain language:
  - "Admins can switch Slack messages between Off, Preview and Live on Data → Notifications, see each weekly and monthly digest's status and when it goes out, and send one now."
  - "Adding people to the Pilot list can send them the latest weekly and monthly straight away, and the whole list can be emptied in one go."
  - "Month-end reminders to paste Claude Team spend now arrive at 09:30, 15:00 and 17:30 on the month's last working day, and stop once it's pasted."

- [ ] **Step 3: CLAUDE.md**: in the Slack digests paragraph, replace "`SLACK_NOTIFY_MODE` off|preview|live (unset = **off**; …)" with the stored-mode rule (migration `0026`, applied before deploy; `mode-store.ts:currentMode`; env var only when no row, or on non-production deployments), add `runNotify` `only` / `send-now.ts`, the digests table, and the three month-end slots.

- [ ] **Step 4: Full suite, lint, `CI=true npm run build`; commit**

```bash
git commit -m "docs(notify): notification controls — changelog and CLAUDE.md"
```
