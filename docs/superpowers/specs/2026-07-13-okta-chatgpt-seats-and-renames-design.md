# ChatGPT Seats from Okta + API Vendor Renames

**Date:** 2026-07-13
**Status:** Approved design

## Problem

1. The vendor labels "Anthropic" and "OpenAI" are ambiguous now that ChatGPT
   Business and Claude Team are tracked alongside the API platforms.
2. ChatGPT seat membership still depends on a manual monthly paste of the
   workspace-analytics table, with fuzzy display-name matching. Okta already
   knows exactly who has ChatGPT access: the **`access-chatgpt`** group.

## Decisions (agreed with Gareth)

1. Rename display labels: `anthropic` → **"Anthropic API"**, `openai` →
   **"OpenAI API"** (labels only; the `Vendor` enum values are untouched).
2. The Okta `access-chatgpt` group **replaces the paste import** as the source
   of ChatGPT seat members.
3. **Continuous current-month snapshot:** every daily cron run refreshes the
   current UTC month's seat members from the group; the month's last run
   (e.g. Jul 31, 06:00 UTC) is naturally its final snapshot. Past months are
   never touched.
4. The **manual monthly entry stays authoritative** when present: its
   count × price is the month's total and Okta members distribute it
   (existing `computeSeatFacts` semantics — only the member source changes).

## Design

### Renames

`src/lib/types.ts` `VENDOR_LABEL`: `anthropic: "Anthropic API"`,
`openai: "OpenAI API"`. Single source of truth — charts, filters, coverage,
and tooltips inherit it. Update any tests asserting the old labels.

### Okta group fetcher — `src/lib/ingest/sources/okta.ts`

```ts
export interface OktaGroupMember { email: string /* lowercased profile.email */ }
export type OktaGroupFetcher = (groupName: string) => Promise<OktaGroupMember[]>;
export const fetchOktaGroupMembers: OktaGroupFetcher;
```

- `GET /api/v1/groups?q=<name>` → select the group whose `profile.name`
  matches exactly; **throw** if absent or ambiguous (a renamed/missing group
  must fail the sync loudly, never produce zero seats silently).
- `GET /api/v1/groups/{id}/users` — same Link-header pagination and 429/5xx
  exponential backoff as `fetchOktaUsers` (reuse the page-fetch helper).
- Uses existing `OKTA_ORG_URL` / `OKTA_API_TOKEN` (SSWS). No new secrets.
  The token must be able to read groups; if it can't, the sync errors loudly.

### Seats orchestrator — `src/lib/ingest/run-chatgpt-seats.ts`

```ts
export const CHATGPT_OKTA_GROUP = "access-chatgpt";
export async function syncChatGptSeats(
  supabase: SupabaseClient,
  fetcher: OktaGroupFetcher = fetchOktaGroupMembers,
): Promise<{ rowsWritten: number }>;
```

Steps (all inside the existing `startSyncRun`/`finishSyncRun` bookkeeping,
source `"chatgpt_seats"`):
1. `month` = current UTC month's first day (`new Date().toISOString().slice(0,7) + "-01"`).
2. Fetch group members → lowercased emails, de-duplicated.
3. Resolve employees by exact email (`loadEmployees` + `matchIdentity`, the
   same resolution the credits import uses) → `SeatMember[]` with
   `entityKey: email`, `employeeId` or null.
4. `entry = getSeatMonthEntry(supabase, month)`;
   `defaultPrice = seat_prices["chatgpt_business:chatgpt"] ?? 25`.
5. `computeSeatFacts(month, entry, members, defaultPrice)` →
   `replaceSeatMonth(supabase, month, facts)`.

Registered in `run-all.ts:runAllSyncs` as its own source-isolated step (an
Okta failure can't block other vendors; theirs can't block seats). The
`?source=` filter on the cron route gains `chatgpt_seats`.

Notes:
- **Entity keys become emails** for Okta-sourced months. Historical months
  keep their paste-derived name keys — attribution flows via `employee_id`,
  and each month is internally consistent because `replaceSeatMonth`
  replaces whole months.
- **Gotcha #4:** a transient empty group response cannot wipe the month —
  with no manual entry the empty fact set only removes the "unassigned
  seats" fact; existing member facts survive and self-heal next run. With a
  manual entry, an empty member list degrades to the single unassigned fact
  (entry-authoritative), which the next successful run re-distributes.
- Manual-entry saves already rebuild from stored facts, so a save between
  cron runs keeps the Okta-derived members.

### Paste retirement

Delete: the "ChatGPT Business — workspace analytics" panel from
`imports/page.tsx`, `src/components/chatgpt-import.tsx`,
`previewChatGptImport`/`commitChatGptImport` (+ their types) from
`imports/actions.ts`, and `src/lib/ingest/parsers/chatgpt-clipboard.ts` with
its test. `normalizeName` moves or dies with it (check remaining usages).
The monthly-seats (count × price) card stays. Existing `alias_rule`
identities from past pastes remain in the DB (harmless; historical months
still attribute).

The coverage table's "ChatGPT seats" column continues to show month totals
from facts; cron-sourced months simply have no "imported" annotation (that
annotation only ever reflected manual imports).

### Out of scope

- Backfilling pre-deploy months from Okta (group membership history isn't
  queryable); old months keep paste-derived facts.
- Per-seat-tier pricing for ChatGPT (single price; the manual entry handles
  exceptions).
- Okta group events/webhooks (daily cron granularity is sufficient).

## Testing

- Fetcher: fixture tests — group-name resolution (exact match, not-found →
  throw, multiple-match → throw), member paging across a Link header.
- Orchestrator: injected-fetcher unit test — members + no entry → member ×
  default facts written via `replaceSeatMonth`; members + entry → entry
  total distributed; empty members + no entry → no member-fact wipe.
- Renames: update label assertions; grep for hardcoded "Anthropic"/"OpenAI"
  strings in UI copy.
- `npm run test` + `CI=true npm run build` before commit.

## Rollout

1. Deploy (no migration needed).
2. Confirm the Okta token can read `access-chatgpt` (first cron run errors
   loudly on Data Health if not).
3. Trigger a manual sync (Imports page) to seed the current month.
4. Changelog entry.
