# Okta ChatGPT Seats + API Vendor Renames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the API vendor labels ("Anthropic API" / "OpenAI API") and source ChatGPT seat members from the Okta `access-chatgpt` group via a new daily cron source, retiring the paste import.

**Architecture:** A new `fetchOktaGroupMembers` (exact-name group resolution + Link-paginated member list, reusing the existing SSWS/backoff machinery) feeds a new source-isolated `syncChatGptSeats` orchestrator that refreshes the **current UTC month** through the existing `computeSeatFacts` → `replaceSeatMonth` funnel — the month's last cron run is its final snapshot, and the manual monthly entry stays authoritative. The paste import (panel, component, actions, parser) is deleted.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Supabase, Okta API (SSWS token).

**Spec:** `docs/superpowers/specs/2026-07-13-okta-chatgpt-seats-and-renames-design.md`

## Global Constraints

- Branch off origin/main: `git checkout -b okta-chatgpt-seats origin/main`.
- Labels only: the `Vendor` enum values (`anthropic`, `openai`) are untouched; only `VENDOR_LABEL` strings change.
- The group fetch must **throw** when the group is missing or ambiguous — never silently produce zero seats.
- Gotcha #4 holds: an empty member list with no manual entry must not wipe the month's member facts (`replaceSeatMonth`'s empty path only removes the "unassigned seats" fact).
- `sync_runs.source` is `text` — the new source name is `"chatgpt_seats"` (confirmed: no enum constraint).
- Seat facts: `source: "chatgpt_business"`, `costType: "seat"`, entity keys are **lowercased emails** for Okta-sourced months.
- Default seat price: `seat_prices` row `(chatgpt_business, chatgpt)` `?? 25`.
- No new secrets: reuses `OKTA_ORG_URL` / `OKTA_API_TOKEN`.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Before the final commit: `npm run test` and `CI=true npm run build` must pass.

---

### Task 1: vendor label renames

**Files:**
- Modify: `src/lib/types.ts:58-59`

**Interfaces:**
- Consumes/produces: `VENDOR_LABEL` values only; no type changes.

- [ ] **Step 1: Edit the labels**

In `src/lib/types.ts`, change:

```ts
  anthropic: "Anthropic",
  openai: "OpenAI",
```

to:

```ts
  anthropic: "Anthropic API",
  openai: "OpenAI API",
```

- [ ] **Step 2: Grep for stragglers**

Run: `grep -rn '"Anthropic"\|"OpenAI"\|>Anthropic<\|>OpenAI<' src --include='*.ts' --include='*.tsx'`
Expected: no hits outside `VENDOR_LABEL` (verified at plan time: none exist, including tests). If any UI copy hardcodes the old names, update it to use `VENDOR_LABEL` or the new string.

- [ ] **Step 3: Verify**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all pass (no test asserts the old labels).

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: label API vendors as 'Anthropic API' / 'OpenAI API'

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Okta group-members fetcher

**Files:**
- Modify: `src/lib/ingest/sources/okta.ts`
- Test: `src/lib/ingest/sources/okta.test.ts` (new)

**Interfaces:**
- Consumes: existing `parseNextLink`, `OktaUser` type from `@/lib/ingest/normalizers/okta`.
- Produces (used by Task 3):

```ts
export interface OktaGroupMember { email: string } // lowercased profile.email (login fallback)
export type OktaGroupFetcher = (groupName: string) => Promise<OktaGroupMember[]>;
export const fetchOktaGroupMembers: OktaGroupFetcher;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/ingest/sources/okta.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOktaGroupMembers } from "./okta";

/** Minimal fetch Response stub with an optional Link header. */
const jsonRes = (body: unknown, link?: string) =>
  ({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "link" ? link ?? null : null) },
    json: async () => body,
    text: async () => "",
  }) as unknown as Response;

const stubEnv = () => {
  vi.stubEnv("OKTA_ORG_URL", "https://example.okta.com");
  vi.stubEnv("OKTA_API_TOKEN", "tok");
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchOktaGroupMembers", () => {
  it("resolves the exact-name group among prefix matches and pages members via Link", async () => {
    stubEnv();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/api/v1/groups?")) {
        // `q=` prefix-matches: a look-alike group must be filtered out by exact name.
        return jsonRes([
          { id: "g1", profile: { name: "access-chatgpt-admins" } },
          { id: "g2", profile: { name: "access-chatgpt" } },
        ]);
      }
      if (url.includes("/groups/g2/users") && !url.includes("after=")) {
        return jsonRes(
          [{ profile: { email: "Alex.Morgan@intenthq.com" } }],
          '<https://example.okta.com/api/v1/groups/g2/users?after=xyz&limit=200>; rel="next"',
        );
      }
      if (url.includes("after=xyz")) {
        return jsonRes([{ profile: { login: "jamie.lee@intenthq.com" } }, { profile: {} }]);
      }
      throw new Error(`unexpected url ${url}`);
    }));

    const members = await fetchOktaGroupMembers("access-chatgpt");
    expect(members).toEqual([
      { email: "alex.morgan@intenthq.com" }, // lowercased
      { email: "jamie.lee@intenthq.com" },   // login fallback; empty profile dropped
    ]);
    expect(calls.some((u) => u.includes("/groups/g2/users"))).toBe(true);
    expect(calls.some((u) => u.includes("/groups/g1/"))).toBe(false); // look-alike never fetched
  });

  it("throws when the group is not found", async () => {
    stubEnv();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes([{ id: "g1", profile: { name: "other" } }])));
    await expect(fetchOktaGroupMembers("access-chatgpt")).rejects.toThrow(/not found/i);
  });

  it("throws when multiple groups share the exact name", async () => {
    stubEnv();
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonRes([
        { id: "g1", profile: { name: "access-chatgpt" } },
        { id: "g2", profile: { name: "access-chatgpt" } },
      ]),
    ));
    await expect(fetchOktaGroupMembers("access-chatgpt")).rejects.toThrow(/ambiguous/i);
  });

  it("throws when env vars are missing", async () => {
    // Explicitly blank (not merely unstubbed) so a dev shell exporting real
    // Okta vars can't turn this into a live network call.
    vi.stubEnv("OKTA_ORG_URL", "");
    vi.stubEnv("OKTA_API_TOKEN", "");
    await expect(fetchOktaGroupMembers("access-chatgpt")).rejects.toThrow(/OKTA_ORG_URL/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/ingest/sources/okta.test.ts`
Expected: FAIL — `fetchOktaGroupMembers` not exported.

- [ ] **Step 3: Implement**

In `src/lib/ingest/sources/okta.ts`:

1. Generalize the private page helper. Replace `getUsersPage` with a generic
   `getPage<T>` (same body — only the signature, return type, and error label
   change), and update `fetchOktaUsers` to call it:

```ts
/**
 * GET one page, retrying on 429/5xx with exponential backoff (Okta rate-limits
 * per org), and return the parsed items plus the `rel="next"` URL if any.
 */
async function getPage<T>(url: string, token: string, label: string): Promise<{ page: T[]; next: string | null }> {
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `SSWS ${token}` },
    });
    if (res.ok) {
      const page = (await res.json()) as T[];
      return { page: Array.isArray(page) ? page : [], next: parseNextLink(res.headers.get("link")) };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxAttempts - 1) {
      throw new Error(`Okta ${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(Math.min(1000 * 2 ** attempt, 16_000)); // 1s,2s,4s,8s,16s
  }
}
```

   In `fetchOktaUsers`, the loop body becomes `const { page, next } = await getPage<OktaUser>(url, token, "users");`.

2. Append the group fetcher:

```ts
export interface OktaGroupMember {
  email: string; // lowercased profile.email (login fallback)
}

export type OktaGroupFetcher = (groupName: string) => Promise<OktaGroupMember[]>;

interface OktaGroup {
  id?: string;
  profile?: { name?: string };
}

/**
 * Members of one Okta group, by exact group name. `q=` only prefix-matches,
 * so the exact-name filter happens here — and a missing or ambiguous group
 * THROWS rather than returning zero members (a renamed group must fail the
 * seats sync loudly, never silently empty a month).
 */
export const fetchOktaGroupMembers: OktaGroupFetcher = async (groupName) => {
  const org = process.env.OKTA_ORG_URL;
  const token = process.env.OKTA_API_TOKEN;
  if (!org || !token) throw new Error("OKTA_ORG_URL / OKTA_API_TOKEN not set");
  const base = org.replace(/\/+$/, "");

  const { page: groups } = await getPage<OktaGroup>(
    `${base}/api/v1/groups?q=${encodeURIComponent(groupName)}&limit=100`,
    token,
    "groups",
  );
  const matches = groups.filter((g) => g.profile?.name === groupName);
  if (matches.length === 0) throw new Error(`Okta group "${groupName}" not found`);
  if (matches.length > 1) throw new Error(`Okta group "${groupName}" is ambiguous (${matches.length} exact matches)`);
  const groupId = matches[0].id;
  if (!groupId) throw new Error(`Okta group "${groupName}" has no id`);

  const members: OktaGroupMember[] = [];
  let url: string | null = `${base}/api/v1/groups/${groupId}/users?limit=200`;
  while (url) {
    const { page, next }: { page: OktaUser[]; next: string | null } = await getPage<OktaUser>(url, token, "group users");
    for (const u of page) {
      const email = (u.profile?.email ?? u.profile?.login ?? "").trim().toLowerCase();
      if (email) members.push({ email });
    }
    url = next;
  }
  return members;
};
```

(`OktaUser` is already imported at the top of the file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ingest/sources/okta.test.ts && npx vitest run`
Expected: new tests PASS; whole suite still green (the `getPage` rename is internal).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/sources/okta.ts src/lib/ingest/sources/okta.test.ts
git commit -m "feat: fetch Okta group members (exact-name match, paginated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `chatgpt_seats` sync source

**Files:**
- Create: `src/lib/ingest/run-chatgpt-seats.ts`
- Test: `src/lib/ingest/run-chatgpt-seats.test.ts` (pure helper only)
- Modify: `src/lib/ingest/run-all.ts`

**Interfaces:**
- Consumes: `fetchOktaGroupMembers`/`OktaGroupFetcher`/`OktaGroupMember` (Task 2); `computeSeatFacts`, `getSeatMonthEntry`, `replaceSeatMonth`, `SeatMember` from `@/lib/ingest/seat-months`; `startSyncRun`, `finishSyncRun`, `saveRawPayload`, `loadEmployees` from `@/lib/ingest/persist`; `matchIdentity` from `@/lib/ingest/identity`.
- Produces:

```ts
export const CHATGPT_OKTA_GROUP = "access-chatgpt";
export function toSeatMembers(emails: string[], employees: { id: string; email: string }[]): SeatMember[];
export async function syncChatGptSeats(supabase: SupabaseClient, fetcher?: OktaGroupFetcher): Promise<{ rowsWritten: number }>;
```

- [ ] **Step 1: Write the failing test for the pure helper**

```ts
// src/lib/ingest/run-chatgpt-seats.test.ts
import { describe, expect, it } from "vitest";
import { toSeatMembers } from "./run-chatgpt-seats";

const employees = [
  { id: "e1", email: "alex.morgan@intenthq.com" },
  { id: "e2", email: "jamie.lee@intenthq.com" },
];

describe("toSeatMembers", () => {
  it("dedupes case-insensitively, resolves employees by exact email, keeps unknowns unattributed", () => {
    const members = toSeatMembers(
      ["Alex.Morgan@intenthq.com", "alex.morgan@intenthq.com", "jamie.lee@intenthq.com", "ghost@intenthq.com", "  "],
      employees,
    );
    expect(members).toEqual([
      { entityKey: "alex.morgan@intenthq.com", employeeId: "e1" },
      { entityKey: "jamie.lee@intenthq.com", employeeId: "e2" },
      { entityKey: "ghost@intenthq.com", employeeId: null }, // kept, unattributed (never dropped)
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ingest/run-chatgpt-seats.test.ts`
Expected: FAIL — cannot resolve `./run-chatgpt-seats`.

- [ ] **Step 3: Implement the orchestrator**

```ts
// src/lib/ingest/run-chatgpt-seats.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOktaGroupMembers, type OktaGroupFetcher } from "@/lib/ingest/sources/okta";
import { finishSyncRun, loadEmployees, saveRawPayload, startSyncRun } from "@/lib/ingest/persist";
import { matchIdentity } from "@/lib/ingest/identity";
import { computeSeatFacts, getSeatMonthEntry, replaceSeatMonth, type SeatMember } from "@/lib/ingest/seat-months";

/** The Okta group whose membership defines who holds a ChatGPT seat. */
export const CHATGPT_OKTA_GROUP = "access-chatgpt";

/** Group emails → deduped, employee-resolved SeatMembers. Pure. */
export function toSeatMembers(
  emails: string[],
  employees: { id: string; email: string }[],
): SeatMember[] {
  const seen = new Set<string>();
  const members: SeatMember[] = [];
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    members.push({ entityKey: email, employeeId: matchIdentity(email, employees).employeeId });
  }
  return members;
}

/**
 * ChatGPT seats from Okta: refresh the CURRENT UTC month's seat facts from the
 * access-chatgpt group. The month's last daily run (e.g. Jul 31, 06:00 UTC) is
 * naturally its final snapshot; past months are never touched. A manual
 * seat_month_entries row stays authoritative — computeSeatFacts distributes
 * its total across these members. Fetcher failures (incl. group not found)
 * throw and land on Data Health; an empty member list can't wipe the month
 * (replaceSeatMonth's empty path only removes the unassigned fact, gotcha #4).
 */
export async function syncChatGptSeats(
  supabase: SupabaseClient,
  fetcher: OktaGroupFetcher = fetchOktaGroupMembers,
): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "chatgpt_seats");
  try {
    const groupMembers = await fetcher(CHATGPT_OKTA_GROUP);
    await saveRawPayload(supabase, "chatgpt_seats", runId, { group: CHATGPT_OKTA_GROUP, members: groupMembers });

    const month = new Date().toISOString().slice(0, 7) + "-01"; // current UTC month
    const employees = await loadEmployees(supabase);
    const members = toSeatMembers(groupMembers.map((m) => m.email), employees);

    const entry = await getSeatMonthEntry(supabase, month);
    const { data: priceRows, error } = await supabase
      .from("seat_prices")
      .select("monthly_price_usd")
      .eq("vendor", "chatgpt_business")
      .eq("seat_type", "chatgpt")
      .limit(1);
    if (error) throw new Error(`chatgpt_seats seat_prices: ${error.message}`);
    const defaultPrice = priceRows?.[0] ? Number(priceRows[0].monthly_price_usd) : 25;

    const rowsWritten = await replaceSeatMonth(supabase, month, computeSeatFacts(month, entry, members, defaultPrice));
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
```

- [ ] **Step 4: Register in run-all.ts**

Add the import:

```ts
import { syncChatGptSeats } from "@/lib/ingest/run-chatgpt-seats";
```

Add to the parallel block (after `okta` has run, so employees are fresh):

```ts
  await Promise.all([
    run("cursor", () => syncCursor(supabase, window)),
    run("cursor_models", () => syncCursorModels(supabase, window)),
    run("anthropic", () => syncAnthropic(supabase, window)),
    run("openai", () => syncOpenAI(supabase, window)),
    run("chatgpt_seats", () => syncChatGptSeats(supabase)),
  ]);
```

(The cron route's `?source=` filter works by these names, so `?source=chatgpt_seats` needs no route change.)

- [ ] **Step 5: Verify**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ingest/run-chatgpt-seats.ts src/lib/ingest/run-chatgpt-seats.test.ts src/lib/ingest/run-all.ts
git commit -m "feat: chatgpt_seats cron source — seats from the Okta access-chatgpt group

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: retire the paste import

**Files:**
- Delete: `src/components/chatgpt-import.tsx`, `src/lib/ingest/parsers/chatgpt-clipboard.ts`, `src/lib/ingest/parsers/chatgpt-clipboard.test.ts`
- Modify: `src/app/(dashboard)/imports/actions.ts`, `src/app/(dashboard)/imports/page.tsx`, `src/components/claude-spend-import.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ImportCommitResult` (renamed from `ChatGptCommitResult` — the Claude spend import returns it; shape unchanged: `{ written: number; attributed: number; queued: number; seats?: number }`).

- [ ] **Step 1: actions.ts surgery**

1. Delete `ChatGptPreviewRow`, `ChatGptPreview`, `previewChatGptImport`, and `commitChatGptImport` (the whole "ChatGPT Business analytics paste" section).
2. Rename the shared result type: `ChatGptCommitResult` → `ImportCommitResult` (it's also the return type of `commitClaudeSpendImport` — update that reference).
3. Prune imports that the deleted code was the last consumer of — expected: `parseChatGptMemberTable`, `normalizeName` (from `parsers/chatgpt-clipboard`), `matchByName` (from `identity`), `loadEmployeeNames` (from `persist`), and `computeSeatFacts`/`getSeatMonthEntry`/`replaceSeatMonth`/`SeatMember` (from `seat-months` — `saveSeatMonthEntry`/`deleteSeatMonthEntry` only need `rebuildChatGptSeatMonth`). **Verify each with grep before removing** — remove only what's genuinely unused after the deletion.

- [ ] **Step 2: delete the paste files**

```bash
git rm src/components/chatgpt-import.tsx src/lib/ingest/parsers/chatgpt-clipboard.ts src/lib/ingest/parsers/chatgpt-clipboard.test.ts
```

- [ ] **Step 3: update claude-spend-import.tsx**

Change the type import and state type from `ChatGptCommitResult` to `ImportCommitResult` (2 occurrences).

- [ ] **Step 4: page.tsx**

1. Remove the `ChatGptImport` import and the entire "ChatGPT Business — workspace analytics" `<Panel>`.
2. Update the "ChatGPT Business — monthly seats" panel copy to reflect the new source of members:

```tsx
          <p className="mb-4 text-xs text-muted">
            Seat members sync nightly from the Okta <strong>access-chatgpt</strong> group — the month&rsquo;s last
            sync is its final snapshot. Use this card to override a month&rsquo;s seat count and per-seat price
            (default $25): members share the entered total, and seats beyond the membership show as
            &ldquo;unassigned seats&rdquo;. Removing a month reverts it to synced members × default price.
          </p>
```

- [ ] **Step 5: Verify**

Run: `npx vitest run && npx tsc --noEmit && npm run lint && CI=true npm run build`
Expected: all pass; no dangling references (`grep -rn "chatgpt-clipboard\|ChatGptImport\|ChatGptPreview\|ChatGptCommitResult" src` returns nothing).

- [ ] **Step 6: Commit**

```bash
git add -A src/app/\(dashboard\)/imports src/components src/lib/ingest/parsers
git commit -m "feat: retire the ChatGPT analytics paste import (seats now sync from Okta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: changelog + full verification

**Files:**
- Modify: `src/lib/changelog.ts`

- [ ] **Step 1: Prepend a new entry** (above the existing `2026-07-13` entry — this ships separately):

```ts
  {
    date: "2026-07-14",
    title: "ChatGPT seats sync themselves",
    items: [
      "ChatGPT seat members now come straight from Okta (the access-chatgpt group), refreshed nightly — the end-of-month membership becomes that month's seat count, with exact person attribution. The analytics-table paste is gone.",
      "Your manual monthly seat entry still wins when present — synced members share the entered total.",
      "The API platforms are now labelled 'Anthropic API' and 'OpenAI API' to distinguish them from Claude Team and ChatGPT Business.",
    ],
  },
```

- [ ] **Step 2: Full verification**

Run: `npm run test && npm run lint && CI=true npm run build`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/changelog.ts
git commit -m "docs: changelog for Okta-synced ChatGPT seats and API label renames

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand back**

Do NOT merge/push/deploy. Report the branch is ready and remind the user:
1. No DB migration this time.
2. After deploy, confirm the Okta token can read the `access-chatgpt` group — trigger a manual sync from the Imports page and check Data Health; a permissions problem shows up as a loud `chatgpt_seats` failure.
