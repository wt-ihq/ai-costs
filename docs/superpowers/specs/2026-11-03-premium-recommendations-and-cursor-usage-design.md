# Premium seat recommendations and Cursor usage — design

Date: 2026-11-03. Status: approved by the admin on 2026-11-03.

## Why

Three tools sell a Standard seat and a Premium seat, and bill extra usage on top of the Standard one:

| Tool | Standard | Premium | Step up a month | Extra usage we already hold |
|---|---|---|---|---|
| Cursor (Teams, legacy pricing) | $40 | $120 | $80 | on-demand `overage` facts from the nightly events sync |
| Claude Team | ~£15 | ~£75 | about $98 at October's saved prices and rate | `overage` facts spread daily from the Monday paste |
| ChatGPT Business | $25 | $125 | $100 | `overage` facts from the credits import (daily) |

Some people on Standard seats spend more in extra usage than Premium would cost them. Nobody sees that today without reading person pages one by one. The admin wants a place that lists them, refreshed weekly, and a Monday Slack message to a chosen few so the list is noticed without opening the dashboard. A single week over the line is enough to appear: the point is awareness, not an automatic action.

For Cursor there is a second gap: the dashboard shows what Cursor costs but nothing about how it is used. The nightly sync already fetches per-person daily usage (active days, agent requests, lines of code suggested and kept, most-used model) and throws almost all of it away. Keeping it lets a person's page and the Cursor page give spend some context, and shows seats nobody uses.

## Goals

- A **Recommendations** page in the dashboard listing, per tool, people on a Standard seat whose extra usage over the last four complete weeks exceeded the monthly step up to Premium, with the potential saving and a four-week pattern.
- Cursor seat tiers known to the dashboard, from a CSV export of Cursor's members page uploaded on Data → Imports.
- Cursor daily usage stored and shown on the person page and the Cursor page.
- A weekly Slack DM (the full list, grouped by tool) to recipients chosen on Data → Notifications, on the same readiness and timing rules as the weekly digests.

## Non-goals

- Usage figures in the recommendation rows. Usage lives on the person page and the Cursor page only.
- Changing anyone's seat in a vendor. The dashboard recommends; a human acts.
- Claude Team or ChatGPT usage metrics (no source for them).
- A monthly cadence for the recommendations message.
- Cursor Enterprise analytics (`CURSOR_ANALYTICS_ENABLED` stays as is).
- Adding the Cursor members export to the Imports checklist's monthly tasks.
- OpenTelemetry or any new vendor integration.

## Anti-goals

- Flagging someone already on Premium, or someone whose "extra" is a seat the dashboard mis-priced.
- A list that silently goes stale: an old Cursor roster or an unready week must be visible, not hidden.
- The weekly cron growing heavier before it checks who is due (`run-notify.ts` loads spend only after `sendStates`; keep that).

## The rule

All of this is a pure module, `src/lib/recommendations/rule.ts`, unit-tested with fixtures.

**Window.** The four complete weeks, Monday to Sunday, ending the most recent Sunday ("four weeks to Sunday 8 November"). The dashboard page always shows that window; if the latest week is not ready (below), the page says so in the toolbar and still shows the figures it has.

**Per tool, per person.** Candidates are, for every tool alike: everyone in the vendor's latest roster upload (`seat_assignments`, the same rows the tier comes from), plus anyone with an `overage` fact for that source in the window who is not in it. Not the Okta group: for ChatGPT the group covers about half the workspace (memory `chatgpt-premium-seats-manual.md`), and the roster is what says the tier anyway. This does not change how seat facts are built (the Okta group stays the membership source for those; that decision stands). Flagged only when the tier is Standard. Premium is never flagged. Cursor "Free" and Claude/ChatGPT "Unassigned" are never flagged. A person with extra spend but no roster row counts as Standard and the row says "tier unknown".

**Extra spend** = the person's `overage` facts for that source over the 28 days, summed per week. Claude's daily spread counts (it is the only daily shape there is); the weekly readiness rule guarantees the paste covers the window before the message goes out.

**Step up** = Premium monthly price minus Standard monthly price. Taken from the latest saved seat month for the vendor (`seat_month_entries`, which carries each tier's price and the £ rate it was saved with); when there is none, from `seat_prices`. For Cursor that is $80; Claude about $98; ChatGPT $100. The page prints the figure it used, per tool.

**Flagged** when four-week extra spend > step up. **Potential saving** = extra spend − step up. The caveat is printed once per page and per message: "Premium would have cost less; it would not have covered all of it."

**Pattern word.** A week "counts" when its extra spend is at least a quarter of the step up. Steady: three or four counting weeks. Recent: every counting week is among the latest two. One-off: one counting week, not the latest. Otherwise: "on and off". (If the total beats the step up, at least one week counts.)

**New this week** = flagged in this window and not in the window ending the previous Sunday. Computed, not stored: the rule runs twice. **No longer flagged** is not shown (the message is the full list, version A).

**Excluded:** people with a `leave_date`; entities with no employee (they are in the Data Health unmatched queue already); service accounts.

**Readiness** is a narrower check than the weekly digest's, built from the same pieces in `readiness.ts` (`recommendationsReadiness`): Cursor synced since the week ended, Claude Team pasted as of Sunday, ChatGPT credits imported through Sunday (each manual import only if used in the last two months). Not `weekReadiness` as it stands: that one also waits for Anthropic, OpenAI, Vercel and OpenRouter, none of which the list uses, and OpenAI's nightly run was refused for weeks this autumn; the Monday message must not be held or skipped for a source it doesn't read. The page banner names only outstanding items from this narrower set. The Cursor roster has its own staleness: when the latest upload is more than 35 days old, the page banner and the message say "Cursor seat tiers from 3 Oct — upload a newer members export".

## Data

### Cursor seat tiers: a roster upload

Cursor's Admin API does not expose seat tiers (`/teams/members` is id, email, name, role, isRemoved; verified against the full documentation page on 2026-11-03). The dashboard (Members → export) produces a CSV with the header

```
Name,Email,Role,Seat Type,Included Usage,Free Usage,On-Demand Usage
```

Role is Member, Team Admin or Removed; Seat Type is Standard, Premium or Free.

- `parseSeatRoster` accepts `seat type` as well as `seat tier`, and skips rows whose Role is `Removed`. Status stays optional. Tests cover the Cursor header.
- A third roster card on Data → Imports, "Cursor members", next to the Claude Team and ChatGPT ones, with the same preview (matched / unmatched / by tier) and commit. `TieredVendor` grows to include `cursor`. Commit writes `seat_assignments` rows for the as-of month, same scoped replace as today.
- `seat_prices` gains `cursor:standard` $40, `cursor:premium` $120, `cursor:free` $0 (migration). `cursor:teams` stays so nothing that reads it breaks.
- **Cursor seat facts are priced by tier from the month a roster says so** (my call, see below): `run-cursor.ts` resolves the month's tiers after `normalizeCursor` and `normalizeCursorMembers` (both emit $40 today) and prices each seat `seat_prices[cursor:<tier>]`, default Standard $40. The roster commit re-prices that month's existing Cursor seat facts in place so the Explore totals move without waiting for the night. Months with no roster stay at $40.
  - Cursor needs **its own tier lookup**, not `resolveSeatTiers`/`pickTier`: those know only `standard | premium` (so "free" would be priced $40) and fall back to a *later* month's assignment when a month has none, which would re-price months before the first upload. The Cursor lookup reads `seat_assignments` for that exact month only, and knows `free`.
  - `commitSeatRoster` ends in `rebuildSeatMonth` → `writeTieredSeatMonth`, the Okta-group seat machinery for Claude and ChatGPT. The Cursor branch skips that and re-prices the month's existing `cursor` seat facts instead.

### Cursor daily usage: a new table

`cursor_daily_usage` (migration), one row per (day, entity_key), upserted by the nightly Cursor sync from the daily-usage payload it already fetches, best-effort like `cursor_top_model` (a failure must not fail the seat and overage sync):

```
day, entity_key (email, lowercased), employee_id, is_active,
agent_requests, subscription_included_reqs, usage_based_reqs, api_key_reqs,
total_lines_added, total_lines_deleted, accepted_lines_added, accepted_lines_deleted,
total_accepts, total_rejects, total_applies, total_tabs_shown, total_tabs_accepted,
bugbot_usages, most_used_model, client_version, created_at
```

`CursorUsageRow` declares the extra fields; a normalizer (`normalizeCursorDailyUsage`, fixture-tested) maps them, treating missing numbers as 0 and `isActive` as false. The existing code keys days on a `day` string while Cursor's documentation names the field `date` (epoch ms): the normalizer accepts both, and the builder checks a real stored raw payload (`raw_payloads`, source `cursor`) before settling the day key. `cursor_top_model` is left alone (a later cleanup may read the model from the new table).

Backfill: a **"Rebuild Cursor usage" month action on Data → Sync** (`rebuildCursorDailyUsage`), which fetches daily usage only (30-day chunks via `fetchUsageInChunks`) and upserts the table — not the cron's `?source=cursor&from=&to=` override, which also re-reads every usage event in the window and overran the 300 s cron at month size. After deploy, the admin runs it for every month from **July 2026** (when Cursor data starts) to the current one. Until a month has rows, the person page section and the Cursor page tiles and lists say "No usage data for this month yet" rather than showing zeros or calling every seat unused. "Rows exist for the month" is the test, per month.

Definitions used on the pages (my reading of Cursor's field names; the builder confirms against the Admin API doc and adjusts the labels, not the data):

- Active days: days with `is_active`.
- Agent requests: `agent_requests`, split `subscription_included_reqs` (included) and `usage_based_reqs` (on-demand).
- Lines suggested: `total_lines_added + total_lines_deleted`; lines kept: `accepted_lines_added + accepted_lines_deleted`; "kept" share = kept ÷ suggested.
- On-demand started: the first day in the month with on-demand charges (an `overage` fact or `usage_based_reqs > 0`). The mock-ups showed a "$20 allowance used by 9 Oct" figure; the allowance amount is not available historically, so the tile says "on-demand from 9 Oct" instead.

### Claude Team and ChatGPT

Nothing new. Tiers from the existing roster uploads (`seat_assignments`), extra spend from the existing `overage` facts.

## Pages

The mock-ups the admin approved are committed next to this document in `docs/superpowers/specs/mockups/2026-11-03-recommendations/` (HTML fragments: `recommendations-layout-v2.html` for the page, `cursor-usage-v4.html` for the person page section and the hover bubble, `slack-recommendations.html` for the message, version A). Names in them are made up.

### Recommendations (`/recommendations`, nav entry after Cursor)

Layout B from the mock-ups (`recommendations-layout-v2.html`, columns as in `cursor-usage-v4.html`):

- Toolbar: "Four weeks to Sunday 8 November" · Team filter (All / each department) · "Updated Monday 2 Nov, after the weekly sync" or "Latest week not ready yet: Claude Team paste outstanding".
- Three tiles: tool, "Standard → Premium is +$80 a month", people flagged, potential saving total, how many are already on Premium.
- Per tool, a short heading with the data source and its date ("Seat tiers from the members export of 3 Nov · on-demand spend from the nightly sync"), then a table: Person (links to the person page), Team, extra spend over four weeks (header named per tool: "On-demand, 4 weeks" / "Extra usage, 4 weeks" / "Credits, 4 weeks"), **Potential saving** (bold), **Last 4 weeks**: four small bars, oldest left, no dates; hovering a bar shows "19 to 25 Oct · $184 on-demand" and, for Cursor, "· 1,180 requests · 5 active days"; then the pattern word. Rows sorted by potential saving, all rows shown (no "12 more").
- Footer: the rule in one paragraph, the caveat, the pattern-word legend.
- Empty state per tool: "Nobody on a Standard seat is over the line." A tool whose data is missing (no roster ever uploaded) says so instead of showing zero.
- Visible to anyone with dashboard access (`requireDashboardAccess()` on the page; `pages.test.ts` covers it). Reads go through a new `getRecommendationsCached` in `cached.ts`.

### Person page: "Cursor usage" section

Shown under the spend sections when the person has `cursor_daily_usage` rows. Its own month selector (default: the latest month with rows; the page's period selector does not drive it — my call, the weekly chart only reads well one month at a time). As in `cursor-usage-v4.html`:

- Four tiles: Active days ("18 of 22 working days", most-used model beneath), Agent requests ("4,120", "3,400 included · 720 on-demand"), Lines of code kept ("12,300", "of 13,100 suggested · 94% kept"), Spend ("$582", "$40 seat · on-demand from 9 Oct · $542 on-demand").
- "Agent requests per day": one bar per day, grouped into Monday-to-Sunday weeks; days with on-demand charges in the second colour, inactive days a grey stub, days outside the month blank. Under each week, the Monday's date on one line and "1,180 requests · $184 on-demand" left-aligned beneath (the on-demand part only when there was any). Hover a day for its date and figures. Legend as in the mock-up.
- Working days = Monday to Friday in the month (no holiday calendar).

### Cursor page additions

For the month the page shows:

- Four tiles: People active ("52 of 64 seats", "12 seats unused all month"), Agent requests (total, included · on-demand), Lines of code kept (total, "95% of suggested"), Active days per person (median, "of 22 working days").
- Two lists side by side: "Most active people · agent requests" (bar, name, requests, "· $1,031 on-demand"), and "Seats with little or no use" (name, "0 active days · $40 seat", sorted by active days ascending, with a footer "… 9 more · $480 a month in unused seats" where unused = 0 active days). Both lists show ten rows and link to person pages.

Person-scope and Cursor-scope readers that gain fields mean a `CACHE_VERSION` bump in the same commit.

## Slack message

Version A from `slack-recommendations.html`. One DM per recipient per week, report kind `recommendations`:

```
*Premium seat recommendations* · four weeks to Sunday 8 November
People on a Standard seat whose extra spend over the last four weeks was more than the step up to Premium. 28 people, $6,420 potential saving a month.

*Cursor · 15 people · Standard → Premium is +$80 a month*
• *$951* Tom Okafor, Engineering · steady
• *$462* Lena Fischer, Data · recent · new this week
• …
*Claude Team · 12 people · Standard → Premium is +$98 a month*
• …
*ChatGPT · 1 person · Standard → Premium is +$100 a month*
• …
Amounts are the potential saving: extra spend minus the step up. Premium would have cost less, it would not have covered all of it. Seat tiers from the latest rosters (Cursor export 3 Nov).
[Open recommendations]
```

- Each tool lists up to 10 people, biggest potential saving first, then "… and N more". A tool with nobody flagged is one line: "Cursor · nobody over the line". When nobody is flagged anywhere, the message is two lines (headline and "Nobody on a Standard seat is over the line this week") — sent, so a quiet Monday is distinguishable from a broken cron.
- Lists follow the digest convention: amount first, bold, whole dollars (`render.ts:item`/`list`).
- No first-message intro and no chart image. No fixed-costs setting applies.
- Recipients: `notification_recommendation_recipients` (employee_id primary key, created_by, created_at; migration), managed in a new panel on Data → Notifications next to the company and reminder recipients, with the same add/remove UI and the "Also send them the latest now" catch-up option.
- Schedule: due any working day from Monday 10:30 in the recipient's time zone once the week is ready (`weekReadiness` for the week ending Sunday), skipped if not ready by Friday — identical to the weekly digest. Claimed in `notification_sends` with `report = 'recommendations'` and the weekly period key, never twice; `notification_sends.report` check gains the value (migration). Mode off / preview / live applies as everywhere.
- The preview picker on Data → Notifications gets a "Recommendations" entry; the Digests table's weekly row gets a "Send now" for recommendations too, or a separate small row — builder's call, but Send now (with "Send anyway" past readiness) must exist. `send-now.ts:sendNow`'s `only` filter has no report dimension today, so a weekly "Send now" would fire recommendations as well: `only` gains `report`, and the existing weekly Send now, catch-up and Live test keep sending personal and company reports only.
- "Open recommendations" is the tracked open link (`/api/digest/open/<send id>`); `openRedirectPath` sends a `recommendations` send to `/recommendations`. Test sends link straight there.

## Conventions that apply

- Migration `0027` (seat prices, `cursor_daily_usage`, recipients table, `report` check) applied to production before the deploy; the nightly sync writes the new table from the first run after deploy.
- Every new server action starts with `await requireAdmin()`; the page calls `await requireDashboardAccess()`.
- New heavy reads live in `cached.ts`; writes to `seat_assignments`/`spend_facts` bust `FACTS_TAG`; `CACHE_VERSION` bumped in the same commit as any reader shape change.
- `npm run test` and `CI=true npm run build` before committing; CHANGELOG entry in `src/lib/changelog.ts` in plain language.
- No PII in git or in debug routes; the Cursor CSV in the admin's Downloads folder is not a fixture — tests use made-up names.
- Reconciliation: the Cursor page's "People active" tile against Cursor's own dashboard once, by eye, after the first backfill (gotcha #2).

## Calls I made (not discussed with the admin)

1. **Cursor Premium seats are priced at $120 in the seat facts** from the first month a roster upload says Premium. Today every Cursor seat is $40, so 13 Premium seats under-count by about $1,040 a month. If this is unwanted, the roster still feeds recommendations and the facts stay at $40.
2. The page is visible to everyone with dashboard access, as person pages already are.
3. Pattern words: steady / recent / one-off / on and off, by the quarter-of-step-up rule above.
4. A seat holder missing from the roster counts as Standard, labelled "tier unknown".
5. The step up comes from the latest saved seat month's prices, falling back to `seat_prices`.
6. An empty week still sends a two-line message.
7. The person page's usage section has its own month selector.
8. The "allowance used" dollar figure is dropped in favour of "on-demand from <date>".
9. "New this week" is computed from the previous window, not stored.
10. The Cursor members export does not join the Imports checklist; staleness is shown instead.
11. Candidates for the rule come from the roster upload plus anyone with extra spend, not the Okta group (which misses half the ChatGPT workspace). Seat facts are untouched by this.
12. Recommendations readiness waits only for Cursor, the Claude Team paste and the ChatGPT credits import, not for the other synced sources.
13. Cursor usage is backfilled from July 2026 through a Data → Sync month action; months without rows say so instead of showing zeros.

## Who may see Cursor activity

The Recommendations page shows spend, which every dashboard viewer can already see per person. The Cursor usage additions are different in kind: active days, lines of code kept, a most-active ranking and a "seats with little or no use" list are activity monitoring of named people. **Those sections are admin-only** (`getRole()` gating on the person page and the Cursor page; viewers see neither the sections nor the data in the cached scopes they receive). Approved with the document; switching to everyone later is a one-line change and a `CACHE_VERSION` bump.

## Left to the builder

- Column and tile layout details within the existing UI components; chart implementation (the explore charts use Recharts; small bars may be plain divs).
- Whether the Digests table or a separate row carries the recommendations Send now.
- Block Kit section limits (50 blocks): cap per-tool lists as needed and say "… and N more".
- Test fixtures for the rule (at least: steady, recent, one-off, Premium excluded, Free excluded, tier unknown, new-this-week, empty tool).
