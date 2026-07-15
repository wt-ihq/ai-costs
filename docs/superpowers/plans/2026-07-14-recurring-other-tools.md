# Recurring Other-Tool Costs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manually-entered recurring/amortized costs for arbitrary AI tools, attributed to a chosen department, presented as first-class vendors in Explore.

**Architecture:** A `recurring_costs` table is the source of truth; a pure `computeRecurringFacts` amortizes contracts cent-exactly and a materializer snapshot-replaces the derived `source='other'` facts (rebuilt on every save + nightly cron). `spend_facts` gains a nullable `department` for person-less attribution; readers prefer it over the employee's department. The vendor *dimension* becomes tool-aware (`other:<tool>` keys, labels from the tool name, colors from stored 8-hue slots) so each tool gets its own chip/series/row.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Supabase (Postgres enum caveat), Recharts.

**Spec:** `docs/superpowers/specs/2026-07-14-recurring-other-tools-design.md`

## Global Constraints

- Branch off origin/main: `git checkout -b recurring-other-tools origin/main`.
- All stored fact amounts are **USD**; `usd = round(amount × fx_rate, 2)` (monthly) / `totalCents = round(amount × fx_rate × 100)` split cent-exactly, **last month absorbs the remainder** (contract).
- Recurring facts: `source: "other"`, `costType: "seat"`, `day` = `YYYY-MM-01`, `entityKey = lower(tool) + (department ? "|" + department : "")`, `model` = tool display name, `department` set, `employeeId: null`. Materialized only **through the current UTC month**.
- The `other` fact set is **purely derived** from `recurring_costs` — full snapshot-replace is safe, and zero entries clears it (a documented, deliberate exception to gotcha #4's spirit; the table is the source of truth).
- Tool colors: `OTHER_TOOL_PALETTE` (8 hues), slot stored per tool at first entry (lowest free slot; all taken → least-used). Colors never repaint on filter changes.
- Gotcha #1 (paginate growing tables, unique tiebreaker) everywhere; single-row `.limit(1)` exempt.
- Every `"use server"` action starts with `await requireAdmin()`.
- Data-health unmatched queues **skip `source='other'` facts entirely** (deliberate manual entries, never assignable).
- `Vendor` union gains `"other"`; `VENDOR_LABEL.other = "Other tools"`, `VENDOR_COLORS.other = "#8b92a5"` (fallback only).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Final: `npm run test && CI=true npm run build` pass. Do NOT merge/push/deploy. Migration 0008 must be applied to prod first — **the `ALTER TYPE` statement must be run on its own** before the rest (Postgres forbids mixing it with other statements in one transaction).

---

### Task 1: migration 0008 + the `other` vendor identity

**Files:**
- Create: `supabase/migrations/0008_recurring_costs.sql`
- Modify: `src/lib/types.ts` (Vendor union + label), `src/lib/colors.ts` (color)

**Interfaces:**
- Produces: `Vendor` includes `"other"`; `VENDOR_LABEL.other`, `VENDOR_COLORS.other`.

- [ ] **Step 1: Migration**

```sql
-- supabase/migrations/0008_recurring_costs.sql
-- NOTE (prod apply): run the ALTER TYPE line as its OWN statement first —
-- Postgres cannot mix "ALTER TYPE ... ADD VALUE" with other statements in
-- one transaction.
alter type vendor add value 'other';

-- Fact-level department attribution: recurring tool costs have no employee.
alter table spend_facts add column department text;

-- Source of truth for manual recurring/amortized tool costs. Facts with
-- source='other' are derived from this table and fully rebuilt from it.
create table recurring_costs (
  id          uuid primary key default gen_random_uuid(),
  tool        text not null,            -- display name; identity = lower(tool)
  color_slot  integer not null check (color_slot between 0 and 7),
  department  text,                     -- null => Unattributed
  kind        text not null check (kind in ('monthly', 'contract')),
  amount      numeric not null check (amount >= 0),  -- per month (monthly) or total (contract)
  currency    text not null default 'USD' check (currency in ('USD', 'GBP', 'EUR')),
  fx_rate     numeric not null default 1 check (fx_rate > 0),
  start_month date not null,            -- YYYY-MM-01
  end_month   date,                     -- inclusive month; required for 'contract' (app-enforced)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
```

- [ ] **Step 2: Types + colors**

`src/lib/types.ts` — add `| "other"` to the `Vendor` union and `other: "Other tools",` to `VENDOR_LABEL`. `src/lib/colors.ts` — add `other: "#8b92a5",` to `VENDOR_COLORS`.

- [ ] **Step 3: Verify** — `npx vitest run && npx tsc --noEmit && npm run lint`. Expected: all pass (Record<Vendor,…> exhaustiveness forces exactly these two additions; the data-health VENDORS list picks up "Other tools" automatically — that's intended).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0008_recurring_costs.sql src/lib/types.ts src/lib/colors.ts
git commit -m "feat: recurring_costs table + 'other' vendor identity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: pure amortization + color-slot picker

**Files:**
- Create: `src/lib/ingest/recurring.ts`
- Test: `src/lib/ingest/recurring.test.ts`

**Interfaces:**
- Consumes: `ResolvedFact` from `@/lib/ingest/persist`.
- Produces (used by Tasks 3, 7):

```ts
export interface RecurringEntry {
  tool: string;
  department: string | null;
  kind: "monthly" | "contract";
  amount: number;
  fxRate: number;           // to USD; 1 for USD
  startMonth: string;       // YYYY-MM-01
  endMonth: string | null;  // inclusive; non-null for contracts
}
export function monthsBetween(startMonth: string, endMonth: string): string[]; // inclusive YYYY-MM-01 list
export function computeRecurringFacts(entries: RecurringEntry[], throughMonth: string): ResolvedFact[];
export function pickColorSlot(existing: { tool: string; colorSlot: number }[], tool: string): number;
```

- [ ] **Step 1: Failing tests**

```ts
// src/lib/ingest/recurring.test.ts
import { describe, expect, it } from "vitest";
import { computeRecurringFacts, monthsBetween, pickColorSlot, type RecurringEntry } from "./recurring";

const THROUGH = "2026-07-01";
const entry = (over: Partial<RecurringEntry>): RecurringEntry => ({
  tool: "Perplexity", department: "Data Science", kind: "monthly",
  amount: 40, fxRate: 1, startMonth: "2026-05-01", endMonth: null, ...over,
});
const totalCents = (facts: { costUsd: number }[]) => Math.round(facts.reduce((s, f) => s + f.costUsd * 100, 0));

describe("monthsBetween", () => {
  it("is inclusive and rolls years", () => {
    expect(monthsBetween("2026-11-01", "2027-02-01")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
  });
});

describe("computeRecurringFacts", () => {
  it("monthly: one seat fact per month from start through the current month", () => {
    const facts = computeRecurringFacts([entry({})], THROUGH);
    expect(facts.map((f) => f.day)).toEqual(["2026-05-01", "2026-06-01", "2026-07-01"]);
    expect(facts[0]).toMatchObject({
      source: "other", costType: "seat", costUsd: 40,
      entityKey: "perplexity|Data Science", model: "Perplexity",
      department: "Data Science", employeeId: null,
    });
  });

  it("monthly: clips at end_month; £ converts once", () => {
    const facts = computeRecurringFacts([entry({ amount: 40, fxRate: 1.27, endMonth: "2026-06-01" })], THROUGH);
    expect(facts.map((f) => f.day)).toEqual(["2026-05-01", "2026-06-01"]);
    expect(facts[0].costUsd).toBe(50.8); // round(40 × 1.27, 2)
  });

  it("contract: cent-exact even split, last month absorbs the remainder", () => {
    // €1000 at 1.17 = $1170.00 across 7 months: 6 × $167.14 + $167.16
    const facts = computeRecurringFacts(
      [entry({ kind: "contract", amount: 1000, fxRate: 1.17, startMonth: "2026-01-01", endMonth: "2026-07-01" })],
      THROUGH,
    );
    expect(facts).toHaveLength(7);
    expect(facts.slice(0, 6).every((f) => f.costUsd === 167.14)).toBe(true);
    expect(facts[6].costUsd).toBe(167.16);
    expect(totalCents(facts)).toBe(117000);
  });

  it("contract: future months beyond throughMonth are not materialized yet (remainder month included only when reached)", () => {
    const facts = computeRecurringFacts(
      [entry({ kind: "contract", amount: 1200, fxRate: 1, startMonth: "2026-06-01", endMonth: "2027-05-01" })],
      THROUGH,
    );
    expect(facts.map((f) => f.day)).toEqual(["2026-06-01", "2026-07-01"]); // 2 of 12 months so far
    expect(facts.every((f) => f.costUsd === 100)).toBe(true);
  });

  it("aggregates multiple entries for one (tool, month, department) into one fact", () => {
    const facts = computeRecurringFacts(
      [entry({ amount: 40 }), entry({ amount: 10, startMonth: "2026-07-01" })],
      THROUGH,
    );
    const july = facts.find((f) => f.day === "2026-07-01");
    expect(july?.costUsd).toBe(50);
    expect(facts.filter((f) => f.day === "2026-07-01")).toHaveLength(1);
  });

  it("keeps distinct departments as distinct facts (collision-free keys)", () => {
    const facts = computeRecurringFacts(
      [entry({ startMonth: "2026-07-01" }), entry({ startMonth: "2026-07-01", department: null })],
      THROUGH,
    );
    expect(facts.map((f) => f.entityKey).sort()).toEqual(["perplexity", "perplexity|Data Science"]);
    expect(facts.find((f) => f.entityKey === "perplexity")?.department).toBeNull();
  });

  it("ignores entries starting after throughMonth", () => {
    expect(computeRecurringFacts([entry({ startMonth: "2026-08-01" })], THROUGH)).toEqual([]);
  });
});

describe("pickColorSlot", () => {
  const t = (tool: string, colorSlot: number) => ({ tool, colorSlot });
  it("reuses the existing slot for a known tool (case-insensitive)", () => {
    expect(pickColorSlot([t("Perplexity", 3)], "perplexity")).toBe(3);
  });
  it("assigns the lowest free slot to a new tool", () => {
    expect(pickColorSlot([t("A", 0), t("B", 2)], "C")).toBe(1);
  });
  it("reuses the least-used slot when all 8 are taken", () => {
    const existing = [0, 1, 2, 3, 4, 5, 6, 7, 0].map((s, i) => t(`T${i}`, s)); // slot 0 used twice
    expect(pickColorSlot(existing, "New")).toBe(1); // lowest among the least-used (1..7 used once)
  });
});
```

- [ ] **Step 2: RED** — `npx vitest run src/lib/ingest/recurring.test.ts` fails on the import.

- [ ] **Step 3: Implement**

```ts
// src/lib/ingest/recurring.ts
import type { ResolvedFact } from "@/lib/ingest/persist";

export interface RecurringEntry {
  tool: string;
  department: string | null;
  kind: "monthly" | "contract";
  amount: number;         // per month (monthly) or total (contract), in `currency`
  fxRate: number;         // to USD; 1 for USD
  startMonth: string;     // YYYY-MM-01
  endMonth: string | null; // inclusive; non-null for contracts (app-enforced)
}

/** Inclusive YYYY-MM-01 list from start to end. */
export function monthsBetween(startMonth: string, endMonth: string): string[] {
  const out: string[] = [];
  let [y, m] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Derived facts for all recurring entries, through `throughMonth` (the
 * current UTC month — future months appear as time passes). Monthly entries
 * repeat round(amount × fx, 2); contracts split their USD total cent-exactly
 * across the FULL contract period (last month absorbs the remainder), then
 * clip to throughMonth. One fact per (tool, month, department).
 */
export function computeRecurringFacts(entries: RecurringEntry[], throughMonth: string): ResolvedFact[] {
  const byKey = new Map<string, ResolvedFact>();
  for (const e of entries) {
    const monthCents = new Map<string, number>();
    if (e.kind === "monthly") {
      const end = e.endMonth && e.endMonth < throughMonth ? e.endMonth : throughMonth;
      if (e.startMonth > end) continue;
      const cents = Math.round(e.amount * e.fxRate * 100);
      for (const m of monthsBetween(e.startMonth, end)) monthCents.set(m, cents);
    } else {
      const months = monthsBetween(e.startMonth, e.endMonth!); // full period drives the split
      const totalCents = Math.round(e.amount * e.fxRate * 100);
      const per = Math.floor(totalCents / months.length);
      months.forEach((m, i) => {
        if (m > throughMonth) return;
        monthCents.set(m, i === months.length - 1 ? totalCents - per * (months.length - 1) : per);
      });
    }
    for (const [month, cents] of monthCents) {
      const entityKey = e.tool.toLowerCase() + (e.department ? `|${e.department}` : "");
      const k = `${entityKey}|${month}`;
      const f = byKey.get(k) ?? {
        source: "other" as const,
        day: month,
        costType: "seat" as const,
        entityKey,
        costUsd: 0,
        model: e.tool,
        department: e.department,
        employeeId: null,
      };
      f.costUsd = Math.round((f.costUsd * 100 + cents)) / 100;
      byKey.set(k, f);
    }
  }
  return [...byKey.values()];
}

/** Stable color slot: a known tool keeps its slot; new tools take the lowest free, else the least-used (lowest wins ties). */
export function pickColorSlot(existing: { tool: string; colorSlot: number }[], tool: string): number {
  const known = existing.find((t) => t.tool.toLowerCase() === tool.toLowerCase());
  if (known) return known.colorSlot;
  const counts = Array.from({ length: 8 }, () => 0);
  for (const t of existing) counts[t.colorSlot] += 1;
  const min = Math.min(...counts);
  return counts.indexOf(min);
}
```

**Type note:** `ResolvedFact extends SpendFact` — `SpendFact` needs the new optional field. In `src/lib/types.ts` add `department?: string | null;` to `SpendFact`, and in `src/lib/ingest/persist.ts:upsertSpendFacts`'s `toRow` add `department: f.department ?? null,` so the column persists.

- [ ] **Step 4: GREEN + suite** — `npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/recurring.ts src/lib/ingest/recurring.test.ts src/lib/types.ts src/lib/ingest/persist.ts
git commit -m "feat: recurring-cost amortization + color-slot assignment

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: materializer, cron source, Data Health

**Files:**
- Modify: `src/lib/ingest/recurring.ts` (I/O), `src/lib/ingest/run-all.ts`, `src/lib/queries/data-health.ts`
- Test: `src/lib/ingest/recurring.test.ts` (zero-entries clear, fake client)

**Interfaces:**
- Produces:

```ts
export async function fetchRecurringEntries(supabase): Promise<(RecurringEntry & { id: string; colorSlot: number; currency: string })[]>;
export async function rebuildRecurringFacts(supabase): Promise<number>;
export async function syncRecurring(supabase): Promise<{ rowsWritten: number }>; // sync_runs source "recurring"
```

- [ ] **Step 1: I/O in recurring.ts**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { replaceWindowFacts } from "@/lib/ingest/persist"; // merge with the type-only import

/** All recurring entries (paginated, gotcha #1 — the table grows forever). */
export async function fetchRecurringEntries(
  supabase: SupabaseClient,
): Promise<(RecurringEntry & { id: string; colorSlot: number; currency: string })[]> {
  const PAGE = 1000;
  const out: (RecurringEntry & { id: string; colorSlot: number; currency: string })[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("recurring_costs")
      .select("id, tool, color_slot, department, kind, amount, currency, fx_rate, start_month, end_month")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetchRecurringEntries: ${error.message}`);
    for (const r of data ?? []) {
      out.push({
        id: r.id as string,
        tool: r.tool as string,
        colorSlot: Number(r.color_slot),
        department: (r.department as string) ?? null,
        kind: r.kind as "monthly" | "contract",
        amount: Number(r.amount),
        currency: r.currency as string,
        fxRate: Number(r.fx_rate),
        startMonth: r.start_month as string,
        endMonth: (r.end_month as string) ?? null,
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * Rebuild ALL source='other' facts from recurring_costs (the source of
 * truth). Zero entries is the one intentional full clear — these facts are
 * purely derived, so wiping them cannot lose information (deliberate,
 * documented exception to gotcha #4's spirit).
 */
export async function rebuildRecurringFacts(supabase: SupabaseClient): Promise<number> {
  const entries = await fetchRecurringEntries(supabase);
  const throughMonth = new Date().toISOString().slice(0, 7) + "-01";
  const facts = computeRecurringFacts(entries, throughMonth);
  if (facts.length === 0) {
    const { error } = await supabase.from("spend_facts").delete().eq("source", "other");
    if (error) throw new Error(`rebuildRecurringFacts clear: ${error.message}`);
    return 0;
  }
  const startDate = facts.reduce((min, f) => (f.day < min ? f.day : min), facts[0].day);
  const window = { startDate, endDate: throughMonth.slice(0, 8) + "02" }; // exclusive-end just past current month-01
  return replaceWindowFacts(supabase, "other", window, facts);
}

/** Nightly cron step: extends open-ended monthlies into each new month. */
export async function syncRecurring(supabase: SupabaseClient): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "recurring");
  try {
    const rowsWritten = await rebuildRecurringFacts(supabase);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
```

(Import `startSyncRun`/`finishSyncRun` from persist. Note the replace window: facts are all stamped month-01 and the earliest fact's day is the window start, so upsert-before-prune covers every previously-materialized month.)

- [ ] **Step 2: run-all + data-health**
- `run-all.ts`: import `syncRecurring`; add `run("recurring", () => syncRecurring(supabase)),` to the parallel block.
- `data-health.ts`:
  1. Add `"recurring"` to the sync-run source list (beside the seat syncs).
  2. Extend the fold map: `const SEAT_SYNC: Partial<Record<Vendor, string>> = { chatgpt_business: "chatgpt_seats", claude_team: "claude_seats", other: "recurring" };` (rename the const to `VENDOR_SYNC` and update its comment — it now covers more than seats).
  3. In the unmatched-classification loop, skip `other` facts entirely (before the pseudo/unmatched bucketing): `if (f.source === "other") continue;` with the comment `// recurring tool costs are deliberate manual entries — never assignable`. (Place it after the count/latest updates so the "Other tools" row still shows fact counts.)

- [ ] **Step 3: zero-entries test** — add to `recurring.test.ts` a stateful-fake test (model on `fakeSpendFactsDb` in `persist.test.ts`, plus a `recurring_costs` select chain returning no rows and a `sync_runs`-free direct call): seed one `source: "other"` fact, call `rebuildRecurringFacts(client)`, assert the fact is deleted and 0 returned. And the inverse: with one monthly entry row in the fake, assert facts get upserted (returned count > 0).

- [ ] **Step 4: Verify + commit** — `npx vitest run && npx tsc --noEmit && npm run lint`

```bash
git add src/lib/ingest/recurring.ts src/lib/ingest/recurring.test.ts src/lib/ingest/run-all.ts src/lib/queries/data-health.ts
git commit -m "feat: recurring cron source + materializer + Data Health wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: readers — fact-level department

**Files:**
- Modify: `src/lib/queries/common.ts`, `src/lib/queries/explore.ts`, `src/lib/explore/build.ts`

**Interfaces:**
- Produces:
  - `EnrichedFact.department` = fact department ?? employee department (same field as today, new precedence).
  - `FactFilter` gains `department?: string` (team scope) and the Unattributed scope excludes department-carrying facts.
  - `RawScope` (all three kinds) gains `toolColors: Record<string, string>` (tool display name → hex).
  - `getToolColors(supabase): Promise<Record<string, string>>` exported from `src/lib/queries/explore.ts`.

- [ ] **Step 1: common.ts**
- Select adds the column: `"day, source, cost_type, cost_usd, requests, entity_key, model, employee_id, department, employees(full_name, department)"`.
- Mapping: `department: (r.department as string | null) ?? emp?.department ?? null,`.
- `FactFilter` gains `/** Also include person-less facts attributed to this department (recurring tool costs). */ department?: string;`.
- Filter application (read the current block first; it applies `employeeIds`/`includeNullEmployee` — replace with):

```ts
    if (filter) {
      const ids = filter.employeeIds.join(",");
      if (filter.department) {
        // Team scope: employees' facts OR person-less facts pinned to the team.
        const deptEq = `department.eq."${filter.department.replace(/"/g, '')}"`;
        q = filter.employeeIds.length ? q.or(`employee_id.in.(${ids}),${deptEq}`) : q.or(deptEq);
      } else if (filter.includeNullEmployee) {
        // Unattributed scope: no employee AND no department attribution.
        q = filter.employeeIds.length
          ? q.or(`employee_id.in.(${ids}),and(employee_id.is.null,department.is.null)`)
          : q.is("employee_id", null).is("department", null);
      } else {
        q = q.in("employee_id", filter.employeeIds);
      }
    }
```

- Early-return guard becomes: `if (filter && filter.employeeIds.length === 0 && !filter.includeNullEmployee && !filter.department) return [];`

- [ ] **Step 2: explore.ts**

```ts
import { OTHER_TOOL_PALETTE } from "@/lib/colors";

/** tool display name → stable hex, from recurring_costs color slots. */
export async function getToolColors(supabase: SupabaseClient): Promise<Record<string, string>> {
  const { data, error } = await supabase.from("recurring_costs").select("tool, color_slot").limit(1000);
  if (error) throw new Error(`getToolColors: ${error.message}`);
  const out: Record<string, string> = {};
  for (const r of data ?? []) out[r.tool as string] = OTHER_TOOL_PALETTE[Number(r.color_slot) % OTHER_TOOL_PALETTE.length];
  return out;
}
```

(`.limit(1000)` is a bounded read over a table that grows by a handful of rows a year — acceptable; add that comment.) Attach `toolColors: await getToolColors(supabase)` in `getCompanyScope`, `getTeamScope`, and the person scope (fetch it in each scope's `Promise.all`-style flow); pass `department: team` in `getTeamScope`'s `fetchScope` filter (NOT for the Unattributed pseudo-team, which keeps `includeNullEmployee`).

- [ ] **Step 3: build.ts** — each `RawScope` variant gains `toolColors: Record<string, string>`; `buildExploreData` threads it into the shapers per Task 5's signatures.

- [ ] **Step 4: Verify + commit** — `npx vitest run && npx tsc --noEmit && npm run lint` (Task 5 lands the shaper signatures — if compile order bites, Tasks 4+5 may be committed together; prefer separate commits when green independently, and say so in the report).

```bash
git add src/lib/queries/common.ts src/lib/queries/explore.ts src/lib/explore/build.ts
git commit -m "feat: fact-level department flows through the explore readers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: tool-aware vendor dimension (shape layer)

**Files:**
- Modify: `src/lib/colors.ts` (palette), `src/lib/explore/shape.ts`, `src/lib/explore/types.ts` (RankSegment)
- Test: `src/lib/explore/shape.test.ts`

**Interfaces:**
- Produces (used by Task 6):

```ts
// colors.ts
export const OTHER_TOOL_PALETTE: string[]; // 8 hues, distinct from VENDOR_COLORS
// shape.ts
export type ToolColors = Record<string, string>;
export function dimLabel(dim: Dim, key: string): string;                       // "other:Perplexity" → "Perplexity"
export function dimColorFor(dim: Dim, key: string, toolColors?: ToolColors): string;
// dimKey (internal): vendor dim key for source==="other" facts is `other:${r.model}`
// RankSegment gains color: string
// segmentsByDim / treemapByDim / rankTeams / rankPeople / rankAllStaff accept a trailing toolColors?: ToolColors
// rankPeople additionally appends non-person rows for department-attributed tool facts (label = tool name)
```

- [ ] **Step 1: Failing tests** (append to shape.test.ts)

```ts
import { dimLabel, dimColorFor } from "./shape";
import { OTHER_TOOL_PALETTE } from "@/lib/colors";

describe("tool-aware vendor dimension", () => {
  const toolFact = (model: string, costUsd: number, department = "Data Science"): ShapeFact => ({
    day: "2026-06-01", source: "other", costType: "seat", costUsd,
    employeeId: null, department, fullName: null, entityKey: model.toLowerCase() + "|" + department, model,
  });
  const toolColors = { Perplexity: OTHER_TOOL_PALETTE[2] };

  it("keys, labels, and colors other-facts by tool", () => {
    expect(dimLabel("vendor", "other:Perplexity")).toBe("Perplexity");
    expect(dimLabel("vendor", "cursor")).toBe("Cursor");
    expect(dimColorFor("vendor", "other:Perplexity", toolColors)).toBe(OTHER_TOOL_PALETTE[2]);
    expect(dimColorFor("vendor", "other:Unknown", toolColors)).toBe("#8b92a5"); // fallback grey
  });

  it("treemap gives each tool its own node", () => {
    const t = treemapByDim([toolFact("Perplexity", 100), toolFact("ElevenLabs", 40)], "vendor", 12, toolColors);
    expect(t.map((n) => n.label).sort()).toEqual(["ElevenLabs", "Perplexity"]);
    expect(t.find((n) => n.label === "Perplexity")?.color).toBe(OTHER_TOOL_PALETTE[2]);
  });

  it("rankTeams lands tool spend on the chosen department with colored segments", () => {
    const r = rankTeams([...june, toolFact("Perplexity", 100, "Eng")], new Map([["Eng", 2]]), toolColors);
    expect(r[0].id).toBe("Eng");
    expect(r[0].total).toBe(240);
    const seg = r[0].segments?.vendor.find((s) => s.key === "other:Perplexity");
    expect(seg).toMatchObject({ value: 100, color: OTHER_TOOL_PALETTE[2] });
  });

  it("rankPeople appends a non-person row per tool for department-attributed facts", () => {
    const r = rankPeople([...june, toolFact("Perplexity", 100, "Eng")], "Eng", [{ id: "a", fullName: "A" }], toolColors);
    const tool = r.find((x) => x.label === "Perplexity");
    expect(tool).toMatchObject({ total: 100, href: undefined });
    expect(tool?.sub).toContain("recurring");
  });

  it("trend series include per-tool keys", () => {
    const pts = trendForPeriod([toolFact("Perplexity", 100)], parsePeriod("2026-06", NOW2), "vendor");
    expect(pts.find((p) => p["other:Perplexity"] !== undefined)).toBeTruthy();
  });
});
```

- [ ] **Step 2: RED**, then **Step 3: implement**
- `colors.ts`:

```ts
/** Reserved hues for user-added tools (recurring costs). Slot-stable: a
 * tool's slot is stored at first entry and never reassigned. */
export const OTHER_TOOL_PALETTE = [
  "#60a5fa", // blue
  "#f87171", // red
  "#facc15", // yellow
  "#2dd4bf", // teal
  "#e879f9", // fuchsia
  "#a3e635", // lime
  "#fb7185", // rose
  "#94a3b8", // slate
];
```

- `shape.ts`:
  - `dimKey`: `dim === "vendor" ? (r.source === "other" ? `other:${r.model}` : r.source) : r.costType`.
  - `export const OTHER_KEY_PREFIX = "other:";`
  - `dimLabel(dim, key)`: vendor dim + `other:` prefix → the suffix verbatim; otherwise the existing labelFor logic (rename/wrap `labelFor`).
  - `dimColorFor(dim, key, toolColors?)`: vendor dim + prefix → `toolColors?.[suffix] ?? VENDOR_COLORS.other`; otherwise existing colorFor. Keep `dimColor` exported as `dimColorFor` alias removal — **update `ranked-list.tsx`'s import in Task 6**, not here.
  - `RankSegment` (in `src/lib/explore/types.ts`) gains `color: string`; `segmentsByDim(rows, toolColors?)` fills it via `dimColorFor`.
  - `treemapByDim(rows, dim, topN = 12, toolColors?)` — label via `dimLabel`, color via `dimColorFor`.
  - `rankTeams(rows, headcounts, toolColors?)`, `rankAllStaff(rows, employees, toolColors?)` — thread to `segmentsByDim`.
  - `rankPeople(rows, teamDept, employees, toolColors?)`: after the person rows, group `rows.filter((r) => r.source === "other" && !r.employeeId)` by `model` and append `{ id: `tool:${model}`, label: model, total, sub: "recurring tool", segments: segmentsByDim(toolRows, toolColors) }`, then re-sort all rows by total desc.
  - `buildExploreData` (Task 4's file) passes `scope.toolColors` into all of these.
- Existing tests: `segmentsByDim` assertions in shape.test.ts now include `color` — update the two `toEqual` segment expectations to `toMatchObject` on key/value (or add the expected colors).

- [ ] **Step 4: GREEN + suite**, then **Step 5: Commit**

```bash
git add src/lib/colors.ts src/lib/explore/shape.ts src/lib/explore/types.ts src/lib/explore/shape.test.ts src/lib/explore/build.ts
git commit -m "feat: tool-aware vendor dimension — per-tool keys, labels, colors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: explore components — chips, charts, filtering

**Files:**
- Modify: `src/lib/explore/vendor-filter.ts` (+ its test if one exists — check), `src/components/explore/explore-view.tsx`, `src/components/explore/trend-chart.tsx`, `src/components/explore/ranked-list.tsx`
- Test: `src/lib/explore/vendor-filter.test.ts` (create if absent)

**Interfaces:**
- Produces:

```ts
// vendor-filter.ts
export type VendorKey = string; // Vendor | `other:${tool}`
export function vendorsInFacts(facts: Pick<ShapeFact, "source" | "model">[]): VendorKey[];
export function parseVendorParam(param: string | undefined, present: VendorKey[]): VendorKey | "all";
export function matchesVendorKey(f: Pick<ShapeFact, "source" | "model">, key: VendorKey): boolean;
```

- [ ] **Step 1: Failing tests** (`src/lib/explore/vendor-filter.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { matchesVendorKey, parseVendorParam, vendorsInFacts } from "./vendor-filter";

const f = (source: string, model = "") => ({ source, model }) as Parameters<typeof matchesVendorKey>[0];

describe("vendor filter with tool keys", () => {
  it("lists tools as their own keys, sorted by label", () => {
    expect(vendorsInFacts([f("cursor"), f("other", "Perplexity"), f("other", "ElevenLabs"), f("other", "Perplexity")]))
      .toEqual(["cursor", "other:ElevenLabs", "other:Perplexity"]);
  });
  it("matches facts to keys", () => {
    expect(matchesVendorKey(f("other", "Perplexity"), "other:Perplexity")).toBe(true);
    expect(matchesVendorKey(f("other", "ElevenLabs"), "other:Perplexity")).toBe(false);
    expect(matchesVendorKey(f("cursor"), "cursor")).toBe(true);
    expect(matchesVendorKey(f("cursor"), "other:Perplexity")).toBe(false);
  });
  it("validates ?vendor= against present keys", () => {
    expect(parseVendorParam("other:Perplexity", ["cursor", "other:Perplexity"])).toBe("other:Perplexity");
    expect(parseVendorParam("other:Ghost", ["cursor"])).toBe("all");
  });
});
```

- [ ] **Step 2: RED**, then **Step 3: implement vendor-filter.ts**

```ts
import type { Vendor } from "@/lib/types";
import { VENDOR_LABEL } from "@/lib/types";
import { dimLabel, OTHER_KEY_PREFIX } from "./shape";
import type { ShapeFact } from "./shape";

/** A concrete vendor, or a first-class tool: `other:<tool display name>`. */
export type VendorKey = string;

export function vendorKeyOf(f: Pick<ShapeFact, "source" | "model">): VendorKey {
  return f.source === "other" ? `${OTHER_KEY_PREFIX}${f.model}` : f.source;
}

/** Unique vendor keys present in the facts, sorted by display label. */
export function vendorsInFacts(facts: Pick<ShapeFact, "source" | "model">[]): VendorKey[] {
  return [...new Set(facts.map(vendorKeyOf))].sort((a, b) =>
    dimLabel("vendor", a).localeCompare(dimLabel("vendor", b)),
  );
}

export function matchesVendorKey(f: Pick<ShapeFact, "source" | "model">, key: VendorKey): boolean {
  return vendorKeyOf(f) === key;
}

/** Validate a ?vendor= param against the keys actually present in scope. */
export function parseVendorParam(param: string | undefined, present: VendorKey[]): VendorKey | "all" {
  return param && present.includes(param) ? param : "all";
}
```

(Delete the now-unused `Vendor`/`VENDOR_LABEL` imports if orphaned — `dimLabel` covers labels.)

- [ ] **Step 4: explore-view.tsx** — mechanical widening:
- `useState<Vendor | "all">` → `useState<VendorKey | "all">`; the facts memo becomes `scope.facts.filter((f) => matchesVendorKey(f, vendor))`.
- `VendorChips` props: `vendors: VendorKey[]`, `active: VendorKey | "all"`; chip dot `background: dimColorFor("vendor", v, toolColors)`; chip text `dimLabel("vendor", v)`; the component takes `toolColors` (pass `scope.toolColors`).
- `CompositionBreakdown` `onSelect`: `(key) => changeVendor(key as VendorKey)` — treemap node keys for the vendor dim are already VendorKeys after Task 5. **Except** the `__other__` overflow node: guard `key.startsWith("__") ? undefined : changeVendor(...)` (check how onSelect currently handles it — mirror existing behavior).
- `TrendChart` gains `toolColors` prop; pass `scope.toolColors`.
- Imports update accordingly (`dimColorFor`, `dimLabel` from shape; `matchesVendorKey`, `VendorKey` from vendor-filter).

- [ ] **Step 5: trend-chart.tsx** — `color(k)`/`label(k)` become `dimColorFor(dim, k, toolColors)` / `dimLabel(dim, k)`; add the `toolColors?: ToolColors` prop; delete the now-unused VENDOR_/COST_ imports if orphaned.

- [ ] **Step 6: ranked-list.tsx** — segment color: `background: s.color` (RankSegment now carries it; drop the `dimColor` import; keep `?? dimColorFor(dim, s.key)` fallback only if tsc complains about optionality — it shouldn't, `color` is required).

- [ ] **Step 7: Verify + commit** — `npx vitest run && npx tsc --noEmit && npm run lint && CI=true npm run build`

```bash
git add src/lib/explore/vendor-filter.ts src/lib/explore/vendor-filter.test.ts src/components/explore/explore-view.tsx src/components/explore/trend-chart.tsx src/components/explore/ranked-list.tsx
git commit -m "feat: first-class tool chips, series, and filtering in Explore

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: server actions + Imports card

**Files:**
- Modify: `src/app/(dashboard)/imports/actions.ts`
- Create: `src/components/recurring-costs.tsx`
- Modify: `src/app/(dashboard)/imports/page.tsx`

**Interfaces:**
- Consumes: `fetchRecurringEntries`, `rebuildRecurringFacts`, `pickColorSlot` (Tasks 2–3); `OTHER_TOOL_PALETTE`.
- Produces:

```ts
export interface RecurringCostInput {
  tool: string; department: string | null; kind: "monthly" | "contract";
  amount: number; currency: "USD" | "GBP" | "EUR"; fxRate: number; // 1 for USD
  startMonth: string; // YYYY-MM
  endMonth: string | null; // YYYY-MM; required for contract
}
export async function saveRecurringCost(input: RecurringCostInput): Promise<{ written: number }>;
export async function endRecurringCost(id: string, endMonth: string /* YYYY-MM */): Promise<{ written: number }>;
export async function deleteRecurringCost(id: string): Promise<{ written: number }>;
export interface RecurringCostRow { // page → component
  id: string; tool: string; color: string; department: string | null; kind: "monthly" | "contract";
  amount: number; currency: string; fxRate: number; startMonth: string; endMonth: string | null; monthlyUsd: number;
}
```

- [ ] **Step 1: actions** (all `requireAdmin()`-first; `MONTH_RE` reused):

```ts
// ---- Recurring costs for other AI tools -------------------------------------

export interface RecurringCostInput {
  tool: string;
  department: string | null;
  kind: "monthly" | "contract";
  amount: number;
  currency: "USD" | "GBP" | "EUR";
  fxRate: number;
  startMonth: string; // YYYY-MM
  endMonth: string | null;
}

export async function saveRecurringCost(input: RecurringCostInput): Promise<{ written: number }> {
  await requireAdmin();
  const tool = input.tool.trim();
  if (!tool) throw new Error("Tool name is required.");
  if (!MONTH_RE.test(input.startMonth)) throw new Error(`Invalid start month "${input.startMonth}".`);
  if (input.endMonth && !MONTH_RE.test(input.endMonth)) throw new Error(`Invalid end month "${input.endMonth}".`);
  if (input.kind === "contract" && !input.endMonth) throw new Error("Contracts need an end month.");
  if (input.endMonth && input.endMonth < input.startMonth) throw new Error("End month is before start month.");
  if (!Number.isFinite(input.amount) || input.amount < 0) throw new Error("Amount must be a number ≥ 0.");
  const fxRate = input.currency === "USD" ? 1 : input.fxRate;
  if (!Number.isFinite(fxRate) || fxRate <= 0) throw new Error("A conversion rate > 0 is required.");
  const supabase = getSupabaseAdminClient();

  const existing = await fetchRecurringEntries(supabase);
  const colorSlot = pickColorSlot(
    existing.map((e) => ({ tool: e.tool, colorSlot: e.colorSlot })),
    tool,
  );

  const { error } = await supabase.from("recurring_costs").insert({
    tool,
    color_slot: colorSlot,
    department: input.department?.trim() || null,
    kind: input.kind,
    amount: input.amount,
    currency: input.currency,
    fx_rate: fxRate,
    start_month: `${input.startMonth}-01`,
    end_month: input.endMonth ? `${input.endMonth}-01` : null,
  });
  if (error) throw new Error(`saveRecurringCost: ${error.message}`);

  const written = await rebuildRecurringFacts(supabase);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
}

export async function endRecurringCost(id: string, endMonth: string): Promise<{ written: number }> {
  await requireAdmin();
  if (!MONTH_RE.test(endMonth)) throw new Error(`Invalid end month "${endMonth}".`);
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("recurring_costs")
    .update({ end_month: `${endMonth}-01`, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`endRecurringCost: ${error.message}`);
  const written = await rebuildRecurringFacts(supabase);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
}

export async function deleteRecurringCost(id: string): Promise<{ written: number }> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("recurring_costs").delete().eq("id", id);
  if (error) throw new Error(`deleteRecurringCost: ${error.message}`);
  const written = await rebuildRecurringFacts(supabase);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
}
```

- [ ] **Step 2: component** `src/components/recurring-costs.tsx` — follow the seat-month-entries card patterns exactly (useTransition, error/success panes, month inputs with the hydration comment). Form fields: tool (text + `<datalist>` of existing tool names), department (text + `<datalist>` of `departments` prop), kind toggle (Monthly / Contract radio-style buttons), amount, currency `<select>` (USD/GBP/EUR), rate input (hidden when USD; prefilled from the tool's most recent entry's `fxRate`, else 1.27 GBP / 1.17 EUR), start month, end month (label "(optional)" for monthly). Entries table: colour dot (`row.color`), tool, department (or "Unattributed"), terms — monthly: `"£40/mo from 2026-03" (+ " until 2026-12" when ended)`; contract: `"€12,000 · 2026-01 → 2026-12"` — monthly-USD equivalent (`formatUsd(row.monthlyUsd)`), and **End** (month input inline or prompt-free: a small month input + button per active row) / **Remove** buttons. Props: `{ entries: RecurringCostRow[]; departments: string[] }`.

- [ ] **Step 3: page wiring** (`imports/page.tsx`):

```ts
  const recurringRaw = await fetchRecurringEntries(supabase);
  const recurringRows: RecurringCostRow[] = recurringRaw.map((e) => {
    const months = e.kind === "contract" ? monthsBetween(e.startMonth, e.endMonth!).length : 1;
    const usd = Math.round(e.amount * e.fxRate * 100) / 100;
    return {
      id: e.id, tool: e.tool, color: OTHER_TOOL_PALETTE[e.colorSlot % OTHER_TOOL_PALETTE.length],
      department: e.department, kind: e.kind, amount: e.amount, currency: e.currency, fxRate: e.fxRate,
      startMonth: e.startMonth.slice(0, 7), endMonth: e.endMonth?.slice(0, 7) ?? null,
      monthlyUsd: e.kind === "contract" ? Math.round((usd / months) * 100) / 100 : usd,
    };
  });
  const departments = [...new Set((await fetchEmployeesAll(supabase, "department")).map((e) => e.department as string | null).filter(Boolean))].sort() as string[];
```

New Panel (after the monthly-seats panel):

```tsx
        <Panel>
          <h2 className="mb-1 text-sm font-medium">Other AI tools — recurring costs</h2>
          <p className="mb-4 text-xs text-muted">
            Tools the dashboard doesn&rsquo;t track automatically. Monthly prices repeat until ended; up-front
            contracts spread evenly across their months. Costs land on the chosen department and each tool
            appears as its own vendor in Explore. Price change? End the entry and add a new one.
          </p>
          <RecurringCosts entries={recurringRows} departments={departments} />
        </Panel>
```

- [ ] **Step 4: Verify + commit** — `npx vitest run && npx tsc --noEmit && npm run lint && CI=true npm run build`

```bash
git add src/app/\(dashboard\)/imports/actions.ts src/components/recurring-costs.tsx src/app/\(dashboard\)/imports/page.tsx
git commit -m "feat: recurring-cost entry card for other AI tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: changelog + full verification

**Files:**
- Modify: `src/lib/changelog.ts`

- [ ] **Step 1: Append to the existing `2026-07-14` entry's items** (keep one entry per day):

```ts
      "You can now add any other AI tool's costs by hand — a monthly price or an up-front contract spread across its months, in £, $, or € — attributed to the department of your choice. Each tool shows up in Explore as its own vendor with its own colour.",
```

- [ ] **Step 2: Full verify** — `npm run test && npm run lint && CI=true npm run build`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/changelog.ts
git commit -m "docs: changelog for recurring other-tool costs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand back** — do NOT merge/push/deploy. Remind the user: (1) apply **migration 0008** to prod first, running the `alter type vendor add value 'other';` line as its own statement before the rest; (2) after deploy, add the first tool on the Imports page and check Explore (tool chip + department row) and Data Health ("Other tools" row + `recurring` sync).
