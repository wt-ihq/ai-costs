# OpenAI Credit-Usage CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the OpenAI admin "Credit Usage Report" CSV as daily, email-attributed, model-labelled `chatgpt_business` overage facts, and narrow the existing paste import to seats-only.

**Architecture:** A new pure parser (`openai-credits.ts`) turns the CSV into aggregated per-(email, day, model) credit rows; new server actions apply an editable USD-per-credit rate and window-replace only the overage slice via `replaceWindowFacts` (which gains an optional cost-type scope); a new Imports-page card drives it. The paste import stops writing overage facts. The coverage table splits the ChatGPT column into seats/credits.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (PostgREST), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-13-openai-credits-csv-import-design.md`

## Global Constraints

- Every `"use server"` action must call `await requireAdmin()` first.
- All windows are exclusive-end `[startDate, endDate)`.
- Never delete-then-insert when the insert might be empty (gotcha #4) — use `replaceWindowFacts` (upsert-before-prune), reject empty imports.
- Any read of a growing table must paginate `.order().range()` with a unique tiebreaker (gotcha #1) — single-row `.limit(1)` lookups are exempt.
- Fact source is `"chatgpt_business"`, credits cost type is `"overage"`, entity key is the **lowercased email**.
- USD-per-credit fallback default: `0.04` (billing page showed 11,732 credits = $469.26 on 2026-07-13).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Before the final commit of the branch: `npm run test` and `CI=true npm run build` must pass.
- Work on a branch: `git checkout -b openai-credits-import` before Task 1.

---

### Task 1: `usage_type` → model label mapping

**Files:**
- Create: `src/lib/ingest/parsers/openai-credits.ts`
- Test: `src/lib/ingest/parsers/openai-credits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `modelLabelFromUsageType(usageType: string): string` — used by Task 2's parser.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/ingest/parsers/openai-credits.test.ts
import { describe, expect, it } from "vitest";
import { modelLabelFromUsageType } from "./openai-credits";

describe("modelLabelFromUsageType", () => {
  // Every usage_type family observed in the real export (2026-07-13).
  it.each([
    // API token line items — input/cached_input/output/cache_write merge to one label
    ["api.gpt_5_5_2026_04_23_text_input_v_1", "GPT-5.5"],
    ["api.gpt_5_5_2026_04_23_text_cached_input_v_1", "GPT-5.5"],
    ["api.gpt_5_5_2026_04_23_text_output_v_1", "GPT-5.5"],
    ["api.gpt_5_4_2026_03_05_text_input_v_1", "GPT-5.4"],
    ["api.gpt_5_4_mini_2026_03_17_text_output_v_1", "GPT-5.4 mini"],
    ["api.gpt_5_2_2025_12_11_text_input_v_1", "GPT-5.2"],
    ["api.gpt_5_3_codex_text_cached_input_v_1", "GPT-5.3 Codex"],
    ["api.gpt_5_6_sol_text_cache_write_input_v_1", "GPT-5.6 Sol"],
    // codex_fast_ prefix → " Codex (fast)" suffix
    ["api.codex_fast_gpt_5_5_2026_04_23_text_input_v_1", "GPT-5.5 Codex (fast)"],
    ["api.codex_fast_gpt_5_6_sol_text_output_v_1", "GPT-5.6 Sol Codex (fast)"],
    ["api.codex_fast_gpt_5_6_luna_text_cached_input_v_1", "GPT-5.6 Luna Codex (fast)"],
    // ChatGPT message counts
    ["chat.completion.5.pro", "GPT-5 Pro (chat)"],
    ["chat.completion.4.5", "GPT-4.5 (chat)"],
    ["chat_agent.completion", "ChatGPT Agent"],
    // Codex task counts
    ["codex", "Codex tasks"],
    ["codex.local.2", "Codex (local)"],
  ])("%s -> %s", (usageType, label) => {
    expect(modelLabelFromUsageType(usageType)).toBe(label);
  });

  it("degrades unknown types to a readable label, never throws", () => {
    expect(modelLabelFromUsageType("some.future_thing.v9")).toBe("some future thing v9");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/ingest/parsers/openai-credits.test.ts`
Expected: FAIL — cannot resolve `./openai-credits`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/ingest/parsers/openai-credits.ts
import type { ParseRowError } from "./types";

const WORD_LABEL: Record<string, string> = { codex: "Codex", pro: "Pro", mini: "mini", fast: "fast" };
const word = (w: string) => WORD_LABEL[w] ?? w.charAt(0).toUpperCase() + w.slice(1);

/** "gpt_5_4_mini" → "GPT-5.4 mini"; "gpt_5_3_codex" → "GPT-5.3 Codex". */
function humanizeModelStem(stem: string): string {
  const m = /^gpt_(\d+)(?:_(\d+))?(.*)$/.exec(stem);
  if (!m) return stem.split("_").filter(Boolean).map(word).join(" ");
  const version = m[2] ? `${m[1]}.${m[2]}` : m[1];
  const rest = m[3].split("_").filter(Boolean).map(word).join(" ");
  return rest ? `GPT-${version} ${rest}` : `GPT-${version}`;
}

/**
 * Humanize an OpenAI credit-report `usage_type` into a model/surface label.
 * Input/cached-input/output token line items of one model map to the SAME
 * label so the parser can merge them into a single fact. Unknown types fall
 * back to a readable form of the raw string — rows are never dropped.
 */
export function modelLabelFromUsageType(usageType: string): string {
  // API token line items: api.<stem>[_YYYY_MM_DD]_text_<kind>_v_<n>
  const api = /^api\.(.+?)_text_(?:cached_input|cache_write_input|input|output)_v_\d+$/.exec(usageType);
  if (api) {
    let stem = api[1].replace(/_20\d{2}_\d{2}_\d{2}$/, ""); // strip model snapshot date
    const fast = stem.startsWith("codex_fast_");
    if (fast) stem = stem.slice("codex_fast_".length);
    return humanizeModelStem(stem) + (fast ? " Codex (fast)" : "");
  }
  // ChatGPT messages: chat.completion.<version-and-tier>
  const chat = /^chat\.completion\.(.+)$/.exec(usageType);
  if (chat) {
    const nums: string[] = [];
    const words: string[] = [];
    for (const part of chat[1].split(".")) (/^\d+$/.test(part) ? nums : words).push(part);
    const tier = words.length ? " " + words.map(word).join(" ") : "";
    return `GPT-${nums.join(".")}${tier} (chat)`;
  }
  if (usageType === "chat_agent.completion") return "ChatGPT Agent";
  if (usageType === "codex") return "Codex tasks";
  if (usageType.startsWith("codex.local")) return "Codex (local)";
  return usageType.replace(/[._]+/g, " ").trim();
}
```

(The `ParseRowError` import is unused until Task 2 — include it now, or add it in Task 2; either is fine as long as lint passes at commit time. If lint complains, add it in Task 2 instead.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ingest/parsers/openai-credits.test.ts`
Expected: PASS (18 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/parsers/openai-credits.ts src/lib/ingest/parsers/openai-credits.test.ts
git commit -m "feat: map OpenAI credit-report usage_type to model labels

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: CSV parser with per-(email, day, model) aggregation

**Files:**
- Modify: `src/lib/ingest/parsers/openai-credits.ts`
- Test: `src/lib/ingest/parsers/openai-credits.test.ts`

**Interfaces:**
- Consumes: `modelLabelFromUsageType` (Task 1), `ParseRowError` from `./types`.
- Produces (used by Task 4's actions):

```ts
export interface CreditUsageFact {
  email: string;            // lowercased
  name: string;             // display name from the CSV (falls back to email)
  day: string;              // YYYY-MM-DD
  model: string;            // humanized label
  credits: number;
  tokens: number | null;    // Σ usage_quantity where usage_units === "tokens"
  requests: number | null;  // Σ usage_quantity where usage_units === "counts"
}
export interface OpenAiCreditsParseResult {
  facts: CreditUsageFact[];
  errors: ParseRowError[];
  minDay: string | null;
  maxDay: string | null;
  totalCredits: number;
}
export function parseOpenAiCreditsCsv(csv: string): OpenAiCreditsParseResult; // throws on header drift
export function coveredWindow(minDay: string, maxDay: string): { startDate: string; endDate: string };
```

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/ingest/parsers/openai-credits.test.ts`:

```ts
import { parseOpenAiCreditsCsv, coveredWindow } from "./openai-credits";

// Real header + representative rows from the actual export. The BOM is
// spelled \uFEFF explicitly so it can't be lost invisibly in copy/paste.
const HEADER =
  "\uFEFF" + "date_partition,account_id,account_user_id,email,name,public_id,usage_type,usage_credits,usage_quantity,usage_units";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

describe("parseOpenAiCreditsCsv", () => {
  it("merges token line items of one model into a single fact per (email, day, model)", () => {
    const { facts, errors, minDay, maxDay, totalCredits } = parseOpenAiCreditsCsv(csv(
      "2026-05-02,acc1,u1,Alex.Morgan@intenthq.com,Alex Morgan,user-1,api.codex_fast_gpt_5_5_2026_04_23_text_input_v_1,100.5,1000000,tokens",
      "2026-05-02,acc1,u1,alex.morgan@intenthq.com,Alex Morgan,user-1,api.codex_fast_gpt_5_5_2026_04_23_text_cached_input_v_1,50.25,5000000,tokens",
      "2026-05-02,acc1,u1,alex.morgan@intenthq.com,Alex Morgan,user-1,api.codex_fast_gpt_5_5_2026_04_23_text_output_v_1,25,200000,tokens",
    ));
    expect(errors).toEqual([]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({
      email: "alex.morgan@intenthq.com", // lowercased
      name: "Alex Morgan",
      day: "2026-05-02",
      model: "GPT-5.5 Codex (fast)",
      credits: 175.75,
      tokens: 6200000,
      requests: null,
    });
    expect(minDay).toBe("2026-05-02");
    expect(maxDay).toBe("2026-05-02");
    expect(totalCredits).toBeCloseTo(175.75);
  });

  it("puts count-based usage in requests, keeps distinct models separate", () => {
    const { facts } = parseOpenAiCreditsCsv(csv(
      "2025-08-14,acc1,u2,jamie.lee@intenthq.com,Jamie Lee,user-2,chat.completion.5.pro,400.0,8.0,counts",
      "2025-08-14,acc1,u2,jamie.lee@intenthq.com,Jamie Lee,user-2,codex,120,3,counts",
    ));
    expect(facts).toHaveLength(2);
    const pro = facts.find((f) => f.model === "GPT-5 Pro (chat)");
    expect(pro).toMatchObject({ credits: 400, requests: 8, tokens: null });
    expect(facts.find((f) => f.model === "Codex tasks")).toMatchObject({ credits: 120, requests: 3 });
  });

  it("collects per-row errors for bad rows and keeps the good ones", () => {
    const { facts, errors } = parseOpenAiCreditsCsv(csv(
      "not-a-date,acc1,u1,x@intenthq.com,X,user-1,codex,10,1,counts",
      "2026-05-02,acc1,u1,,No Email,user-1,codex,10,1,counts",
      "2026-05-03,acc1,u1,ok@intenthq.com,OK,user-1,codex,10,1,counts",
    ));
    expect(facts).toHaveLength(1);
    expect(facts[0].email).toBe("ok@intenthq.com");
    expect(errors).toHaveLength(2);
    expect(errors[0].line).toBe(2); // 1-based, header is line 1
  });

  it("handles quoted fields containing commas", () => {
    const { facts } = parseOpenAiCreditsCsv(csv(
      '2026-05-02,acc1,u1,jo@intenthq.com,"Jones, Jo",user-1,codex,10,1,counts',
    ));
    expect(facts[0].name).toBe("Jones, Jo");
  });

  it("throws on header drift (missing required column)", () => {
    const bad = "date_partition,account_id,email,usage_credits\n2026-05-02,acc1,x@intenthq.com,10";
    expect(() => parseOpenAiCreditsCsv(bad)).toThrow(/missing column/i);
  });

  it("returns an error (not a throw) for an empty file", () => {
    const { facts, errors } = parseOpenAiCreditsCsv("");
    expect(facts).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("coveredWindow", () => {
  it("month-aligns the start (sweeps old month-stamped paste overage) and is exclusive-end", () => {
    expect(coveredWindow("2025-08-14", "2026-07-11")).toEqual({ startDate: "2025-08-01", endDate: "2026-07-12" });
  });

  it("rolls the end over month and year boundaries", () => {
    expect(coveredWindow("2026-12-05", "2026-12-31")).toEqual({ startDate: "2026-12-01", endDate: "2027-01-01" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/ingest/parsers/openai-credits.test.ts`
Expected: FAIL — `parseOpenAiCreditsCsv` not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/ingest/parsers/openai-credits.ts`:

```ts
export interface CreditUsageFact {
  email: string;
  name: string;
  day: string;
  model: string;
  credits: number;
  tokens: number | null;
  requests: number | null;
}

export interface OpenAiCreditsParseResult {
  facts: CreditUsageFact[];
  errors: ParseRowError[];
  minDay: string | null;
  maxDay: string | null;
  totalCredits: number;
}

const REQUIRED_COLUMNS = ["date_partition", "email", "usage_type", "usage_credits", "usage_quantity", "usage_units"];

/** Minimal RFC-4180 line splitter (quoted fields may contain commas). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/**
 * OpenAI admin "Credit Usage Report" CSV (chatgpt.com/admin/billing → Credits
 * balance → Download usage data). One row per day × user × usage_type; this
 * aggregates to one fact per (email, day, model label). Credits are the
 * ADDITIONAL (paid) pool — bundled seat usage is not in this file. Header
 * drift throws; bad rows become ParseRowErrors and good rows still import.
 */
export function parseOpenAiCreditsCsv(csv: string): OpenAiCreditsParseResult {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return { facts: [], errors: [{ line: 0, message: "empty file" }], minDay: null, maxDay: null, totalCredits: 0 };
  }

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col: Record<string, number> = Object.fromEntries(header.map((h, i) => [h, i]));
  const missing = REQUIRED_COLUMNS.filter((c) => col[c] === undefined);
  if (missing.length) {
    throw new Error(`Unrecognized credit-usage CSV — missing column(s): ${missing.join(", ")}. Did OpenAI change the export format?`);
  }

  const errors: ParseRowError[] = [];
  const byKey = new Map<string, CreditUsageFact>();
  let minDay: string | null = null;
  let maxDay: string | null = null;
  let totalCredits = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const day = (cells[col.date_partition] ?? "").trim();
    const email = (cells[col.email] ?? "").trim().toLowerCase();
    const usageType = (cells[col.usage_type] ?? "").trim();
    const credits = Number(cells[col.usage_credits]);
    const quantity = Number(cells[col.usage_quantity]);
    const units = (cells[col.usage_units] ?? "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !email || !usageType || !Number.isFinite(credits)) {
      errors.push({ line: i + 1, message: `unparseable row: "${lines[i].slice(0, 80)}"` });
      continue;
    }

    const model = modelLabelFromUsageType(usageType);
    const key = `${email}|${day}|${model}`;
    const fact = byKey.get(key) ?? {
      email,
      name: (cells[col.name] ?? "").trim() || email,
      day,
      model,
      credits: 0,
      tokens: null,
      requests: null,
    };
    fact.credits += credits;
    if (Number.isFinite(quantity) && quantity > 0) {
      if (units === "tokens") fact.tokens = (fact.tokens ?? 0) + quantity;
      else fact.requests = (fact.requests ?? 0) + quantity;
    }
    byKey.set(key, fact);
    totalCredits += credits;
    if (!minDay || day < minDay) minDay = day;
    if (!maxDay || day > maxDay) maxDay = day;
  }

  return { facts: [...byKey.values()], errors, minDay, maxDay, totalCredits };
}

/**
 * Replace-window for a credits import. Month-aligned start sweeps out old
 * month-stamped paste overage (stamped YYYY-MM-01) in covered months;
 * exclusive-end (day after the last row), matching every window in this repo.
 */
export function coveredWindow(minDay: string, maxDay: string): { startDate: string; endDate: string } {
  const [y, m, d] = maxDay.split("-").map(Number);
  const dayAfter = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { startDate: minDay.slice(0, 7) + "-01", endDate: dayAfter };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ingest/parsers/openai-credits.test.ts`
Expected: PASS.

- [ ] **Step 5: Sanity-check against the real file**

Run:
```bash
npx tsx -e "
import { readFileSync } from 'fs';
import { parseOpenAiCreditsCsv } from './src/lib/ingest/parsers/openai-credits';
const r = parseOpenAiCreditsCsv(readFileSync('analytics/Intent HQ Credit Usage Report (Jul 13, 2025 - Jul 13, 2026).csv', 'utf8'));
console.log('facts:', r.facts.length, 'errors:', r.errors.length, 'range:', r.minDay, '→', r.maxDay, 'credits:', r.totalCredits.toFixed(1));
console.log('models:', [...new Set(r.facts.map(f => f.model))].sort().join(' | '));
"
```
Expected: 0 errors, range `2025-08-14 → 2026-07-11`, credits ≈ `188299.4`, and a model list with no raw `api.…_v_1` strings. (If `tsx` is unavailable, `npm i -D tsx` is NOT needed — instead write the same as a temporary vitest test and delete it.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/ingest/parsers/openai-credits.ts src/lib/ingest/parsers/openai-credits.test.ts
git commit -m "feat: parse OpenAI credit-usage CSV into per-(email, day, model) facts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: cost-type scope for `replaceWindowFacts`

**Files:**
- Modify: `src/lib/ingest/persist.ts:151-183`
- Test: `src/lib/ingest/persist.test.ts`

**Interfaces:**
- Consumes: existing `replaceWindowFacts(supabase, source, window, facts)`.
- Produces: `replaceWindowFacts(supabase, source, window, facts, opts?: { costType?: CostType })` — when `opts.costType` is set, the stale-row scan (and therefore the prune) only sees rows of that cost type; rows of other cost types in the window are untouched. Callers must ensure `facts` all carry that cost type.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/ingest/persist.test.ts`:

```ts
// Add `replaceWindowFacts` to the EXISTING `./persist` import at the top of the
// file (don't create a duplicate import statement).

/** Stateful in-memory spend_facts table supporting the exact call chains replaceWindowFacts makes. */
function fakeSpendFactsDb(initial: Record<string, unknown>[]) {
  const rows = initial.map((r, i) => ({ id: `seed${i}`, ...r }));
  let nextId = 0;
  const client = {
    from: () => ({
      upsert: (incoming: Record<string, unknown>[]) => {
        for (const r of incoming) {
          const key = (x: Record<string, unknown>) => `${x.source}|${x.day}|${x.cost_type}|${x.entity_key}|${x.model}`;
          const idx = rows.findIndex((x) => key(x) === key(r));
          if (idx >= 0) rows[idx] = { ...rows[idx], ...r };
          else rows.push({ id: `new${nextId++}`, ...r });
        }
        return Promise.resolve({ error: null });
      },
      select: () => {
        const filters: ((r: Record<string, unknown>) => boolean)[] = [];
        const q = {
          eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
          gte: (c: string, v: string) => { filters.push((r) => (r[c] as string) >= v); return q; },
          lt: (c: string, v: string) => { filters.push((r) => (r[c] as string) < v); return q; },
          order: () => q,
          range: (from: number, to: number) =>
            Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }),
        };
        return q;
      },
      delete: () => ({
        in: (_c: string, ids: string[]) => {
          for (const id of ids) {
            const i = rows.findIndex((r) => r.id === id);
            if (i >= 0) rows.splice(i, 1);
          }
          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { client, rows };
}

describe("replaceWindowFacts with a cost-type scope", () => {
  it("prunes stale rows only within the scoped cost type — seat facts survive an overage replace", async () => {
    const { client, rows } = fakeSpendFactsDb([
      // paste-era seat fact — must survive
      { source: "chatgpt_business", day: "2026-05-01", cost_type: "seat", entity_key: "alex morgan", model: "", cost_usd: 25 },
      // paste-era month-stamped overage — must be pruned (not in the new snapshot)
      { source: "chatgpt_business", day: "2026-05-01", cost_type: "overage", entity_key: "alex morgan", model: "", cost_usd: 360 },
      // other source in-window — must survive
      { source: "claude_team", day: "2026-05-10", cost_type: "overage", entity_key: "x@intenthq.com", model: "", cost_usd: 9 },
    ]);

    const written = await replaceWindowFacts(
      client,
      "chatgpt_business",
      { startDate: "2026-05-01", endDate: "2026-06-01" },
      [{
        source: "chatgpt_business", day: "2026-05-02", costType: "overage",
        entityKey: "alex.morgan@intenthq.com", costUsd: 7.03, model: "GPT-5.5 Codex (fast)", employeeId: "e1",
      }],
      { costType: "overage" },
    );

    expect(written).toBe(1);
    const keys = rows.map((r) => `${r.source}|${r.cost_type}|${r.entity_key}`);
    expect(keys).toContain("chatgpt_business|seat|alex morgan");                 // survived
    expect(keys).toContain("claude_team|overage|x@intenthq.com");             // survived
    expect(keys).toContain("chatgpt_business|overage|alex.morgan@intenthq.com"); // new fact
    expect(keys).not.toContain("chatgpt_business|overage|alex morgan");          // pruned
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ingest/persist.test.ts`
Expected: FAIL — `replaceWindowFacts` takes 4 arguments (TypeScript error) or the seat fact gets pruned.

- [ ] **Step 3: Implement the scope**

In `src/lib/ingest/persist.ts`:

1. Extend the import at the top: `import type { SpendFact, ModelUsageFact, CostType } from "@/lib/types";`
2. Change `replaceWindowFacts`'s signature and scan query:

```ts
export async function replaceWindowFacts(
  supabase: SupabaseClient,
  source: string,
  window: { startDate: string; endDate: string },
  facts: ResolvedFact[],
  opts?: { costType?: CostType },
): Promise<number> {
  if (facts.length === 0) return 0;
  const written = await upsertSpendFacts(supabase, facts);

  const keep = new Set(facts.map((f) => `${f.day}|${f.costType}|${f.entityKey}|${f.model ?? ""}`));
  const stale: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from("spend_facts")
      .select("id, day, cost_type, entity_key, model")
      .eq("source", source);
    // Scoped replace: prune only within this cost type (e.g. a credits import
    // must never touch seat facts sharing the window).
    if (opts?.costType) query = query.eq("cost_type", opts.costType);
    const { data, error } = await query
      .gte("day", window.startDate)
      .lt("day", window.endDate)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`replaceWindowFacts(${source}): ${error.message}`);
    for (const r of data ?? []) {
      if (!keep.has(`${r.day}|${r.cost_type}|${r.entity_key}|${r.model ?? ""}`)) stale.push(r.id as string);
    }
    if (!data || data.length < PAGE) break;
  }
  for (let i = 0; i < stale.length; i += 500) {
    const { error } = await supabase.from("spend_facts").delete().in("id", stale.slice(i, i + 500));
    if (error) throw new Error(`replaceWindowFacts(${source}) delete: ${error.message}`);
  }
  return written;
}
```

(Everything except the signature line, the `let query` refactor, and the conditional `.eq("cost_type", …)` is unchanged. Keep the existing doc comment and append one sentence: "Pass `opts.costType` to scope the prune to one cost type — other cost types in the window are untouched.")

- [ ] **Step 4: Run the full ingest tests**

Run: `npx vitest run src/lib/ingest/`
Expected: PASS — including existing callers (`run-platforms.ts` compiles unchanged; the new param is optional).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/persist.ts src/lib/ingest/persist.test.ts
git commit -m "feat: optional cost-type scope on replaceWindowFacts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: server actions — preview, commit, and import meta

**Files:**
- Modify: `src/lib/ingest/persist.ts` (add `loadEmployeesFull`)
- Modify: `src/app/(dashboard)/imports/actions.ts`

**Interfaces:**
- Consumes: `parseOpenAiCreditsCsv`, `coveredWindow`, `CreditUsageFact` (Task 2); `replaceWindowFacts(..., { costType: "overage" })` (Task 3); existing `requireAdmin`, `getSupabaseAdminClient`, `upsertSpendFacts` patterns.
- Produces (used by Task 6's component and page):

```ts
export interface OpenAiCreditsFact extends CreditUsageFact { usd: number; employeeId: string | null }
export interface OpenAiCreditsUserRow {
  email: string; name: string; credits: number; usd: number;
  matched: boolean; employeeName: string | null;
}
export interface OpenAiCreditsPreview {
  facts: OpenAiCreditsFact[];
  users: OpenAiCreditsUserRow[];      // sorted by usd desc
  errors: { line: number; message: string }[];
  totalCredits: number; totalUsd: number;
  minDay: string | null; maxDay: string | null;
  matchedCount: number; modelCount: number;
}
export async function previewOpenAiCreditsImport(csv: string, usdPerCredit: number): Promise<OpenAiCreditsPreview>;
export interface OpenAiCreditsCommitResult { written: number; attributed: number; queued: number; from: string; to: string }
export async function commitOpenAiCreditsImport(
  facts: OpenAiCreditsFact[], usdPerCredit: number, fileName: string | null,
): Promise<OpenAiCreditsCommitResult>;
```

Plus in `persist.ts`: `loadEmployeesFull(supabase): Promise<{ id: string; email: string; fullName: string }[]>` (paginated).

- [ ] **Step 1: Add `loadEmployeesFull` to persist.ts**

After `loadEmployeeNames` (`src/lib/ingest/persist.ts:92-94`):

```ts
/** Employees with email + name, paginated (gotcha #1) — for email-keyed import previews. */
export async function loadEmployeesFull(supabase: SupabaseClient) {
  return selectAllRows<{ id: string; email: string; fullName: string }>(
    supabase, "employees", "id, email, fullName:full_name", "loadEmployeesFull",
  );
}
```

- [ ] **Step 2: Add the actions**

In `src/app/(dashboard)/imports/actions.ts`, extend the imports:

```ts
import { parseOpenAiCreditsCsv, coveredWindow, type CreditUsageFact } from "@/lib/ingest/parsers/openai-credits";
import { loadEmployeeNames, loadEmployeesFull, upsertSpendFacts, replaceWindowFacts, type ResolvedFact } from "@/lib/ingest/persist";
```

Add after the ChatGPT section (before `// ---- Claude Team MTD spend`):

```ts
// ---- OpenAI credit-usage CSV (additional/paid credits) ---------------------

export interface OpenAiCreditsFact extends CreditUsageFact {
  usd: number;
  employeeId: string | null;
}

export interface OpenAiCreditsUserRow {
  email: string;
  name: string;
  credits: number;
  usd: number;
  matched: boolean;
  employeeName: string | null;
}

export interface OpenAiCreditsPreview {
  facts: OpenAiCreditsFact[];
  users: OpenAiCreditsUserRow[];
  errors: { line: number; message: string }[];
  totalCredits: number;
  totalUsd: number;
  minDay: string | null;
  maxDay: string | null;
  matchedCount: number;
  modelCount: number;
}

/** Parse the credit-usage CSV, price credits at the given rate, exact-match emails. */
export async function previewOpenAiCreditsImport(
  csv: string,
  usdPerCredit: number,
): Promise<OpenAiCreditsPreview> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const employees = await loadEmployeesFull(supabase);
  const byEmail = new Map(employees.map((e) => [e.email.toLowerCase(), e]));

  const parsed = parseOpenAiCreditsCsv(csv);
  const facts: OpenAiCreditsFact[] = parsed.facts.map((f) => ({
    ...f,
    usd: Math.round(f.credits * usdPerCredit * 100) / 100,
    employeeId: byEmail.get(f.email)?.id ?? null,
  }));

  const users = new Map<string, OpenAiCreditsUserRow>();
  for (const f of facts) {
    const u = users.get(f.email) ?? {
      email: f.email,
      name: f.name,
      credits: 0,
      usd: 0,
      matched: !!f.employeeId,
      employeeName: byEmail.get(f.email)?.fullName ?? null,
    };
    u.credits += f.credits;
    u.usd = Math.round((u.usd + f.usd) * 100) / 100;
    users.set(f.email, u);
  }
  const userRows = [...users.values()].sort((a, b) => b.usd - a.usd);

  return {
    facts,
    users: userRows,
    errors: parsed.errors,
    totalCredits: parsed.totalCredits,
    totalUsd: Math.round(facts.reduce((s, f) => s + f.usd, 0) * 100) / 100,
    minDay: parsed.minDay,
    maxDay: parsed.maxDay,
    matchedCount: userRows.filter((u) => u.matched).length,
    modelCount: new Set(facts.map((f) => f.model)).size,
  };
}

export interface OpenAiCreditsCommitResult {
  written: number;
  attributed: number;
  queued: number;
  from: string;
  to: string;
}

/** Window-replace the overage slice only — seat facts in the window survive. */
export async function commitOpenAiCreditsImport(
  facts: OpenAiCreditsFact[],
  usdPerCredit: number,
  fileName: string | null,
): Promise<OpenAiCreditsCommitResult> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  // Never delete a window when the insert would be empty (gotcha #4).
  if (!facts.length) throw new Error("Nothing to import — the preview has no rows.");

  let minDay = facts[0].day;
  let maxDay = facts[0].day;
  for (const f of facts) {
    if (f.day < minDay) minDay = f.day;
    if (f.day > maxDay) maxDay = f.day;
  }
  const window = coveredWindow(minDay, maxDay);

  const resolved: ResolvedFact[] = facts.map((f) => ({
    source: "chatgpt_business",
    day: f.day,
    costType: "overage",
    entityKey: f.email,
    costUsd: f.usd,
    tokens: f.tokens,
    requests: f.requests,
    model: f.model,
    employeeId: f.employeeId,
  }));
  const written = await replaceWindowFacts(supabase, "chatgpt_business", window, resolved, { costType: "overage" });

  // Record confirmed identity mappings (email → employee).
  const identities = [
    ...new Map(facts.filter((f) => f.employeeId).map((f) => [f.email, f.employeeId])).entries(),
  ].map(([email, employeeId]) => ({
    vendor: "chatgpt_business" as const,
    external_email: email,
    employee_id: employeeId,
    match_method: "exact_email" as const,
  }));
  if (identities.length) {
    await supabase.from("identities").upsert(identities, { onConflict: "vendor,external_email" });
  }

  const attributed = resolved.filter((f) => f.employeeId).length;
  await supabase.from("imports").insert({
    source: "chatgpt_business",
    kind: "csv",
    file_name: fileName,
    data_as_of: maxDay,
    status: "success",
    row_counts: {
      facts: resolved.length,
      users: new Set(facts.map((f) => f.email)).size,
      attributed,
      queued: resolved.length - attributed,
      total_credits: Math.round(facts.reduce((s, f) => s + f.credits, 0)),
      usd_per_credit: usdPerCredit,
      from: minDay,
      to: maxDay,
    },
  });

  revalidatePath("/");
  return { written, attributed, queued: resolved.length - attributed, from: minDay, to: maxDay };
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean. (No unit tests for the actions themselves — all logic lives in the tested parser/persist layers; the actions are Supabase plumbing, consistent with the other imports.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/ingest/persist.ts src/app/\(dashboard\)/imports/actions.ts
git commit -m "feat: preview/commit actions for the OpenAI credit-usage CSV import

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: narrow the paste import to seats-only

**Files:**
- Modify: `src/lib/ingest/parsers/chatgpt-clipboard.ts`
- Modify: `src/lib/ingest/parsers/chatgpt-clipboard.test.ts`
- Modify: `src/app/(dashboard)/imports/actions.ts:22-132`
- Modify: `src/components/chatgpt-import.tsx`

**Interfaces:**
- Consumes: existing paste flow.
- Produces:
  - `parseChatGptMemberTable(text: string): { members: ChatGptMember[]; errors: ParseRowError[] }` — no more `facts`, no `asOf`/`usdPerCredit` params.
  - `previewChatGptImport(text: string): Promise<ChatGptPreview>` — `ChatGptPreviewRow` loses `usd`; `ChatGptPreview` loses `totalUsd`.
  - `commitChatGptImport(rows, asOf)` — writes seat facts only; its snapshot delete is scoped to `cost_type = 'seat'`.

- [ ] **Step 1: Update the parser tests (failing)**

In `src/lib/ingest/parsers/chatgpt-clipboard.test.ts`:
- Change both `parseChatGptMemberTable(pasted, "2026-06-13", 0.01)` / `(blockPasted, "2026-06-15", 0.01)` calls to `parseChatGptMemberTable(pasted)` / `(blockPasted)`.
- Delete the two fact-shaped tests: `"emits overage facts only for members with credits, converted via rate"` (lines 23-32) and `"converts credits to USD overage facts keyed by normalized name"` (lines 63-68). Members still carry `creditsSpent` (displayed read-only), so the member assertions stay.

Run: `npx vitest run src/lib/ingest/parsers/chatgpt-clipboard.test.ts`
Expected: FAIL (signature mismatch).

- [ ] **Step 2: Simplify the parser**

In `src/lib/ingest/parsers/chatgpt-clipboard.ts`:
- Remove the `SpendFact` import and the `facts` field from `ChatGptParseResult`.
- Change the signature to `parseChatGptMemberTable(text: string): ChatGptParseResult`.
- Reduce `add` to:

```ts
  const add = (name: string, creditsSpent: number, messagesSent: number) => {
    members.push({ name, creditsSpent, messagesSent });
  };
```

- Remove the `facts` array and drop `facts` from the return.
- Update the file doc comment: credits are parsed for display only; overage now comes from the credit-usage CSV import.

Run: `npx vitest run src/lib/ingest/parsers/chatgpt-clipboard.test.ts`
Expected: PASS.

- [ ] **Step 3: Update the actions**

In `src/app/(dashboard)/imports/actions.ts`:
- `ChatGptPreviewRow`: delete the `usd` field. `ChatGptPreview`: delete `totalUsd`.
- `previewChatGptImport(text: string)`: drop the `usdPerCredit` param; call `parseChatGptMemberTable(text)`; delete the `usd:` line from the row mapping and the `totalUsd` from the return.
- `commitChatGptImport`:
  - Scope the snapshot delete: `await supabase.from("spend_facts").delete().eq("source", "chatgpt_business").eq("cost_type", "seat").eq("day", day);`
  - Delete the `withSpend` constant and the `overageFacts` block; `upsertSpendFacts(supabase, seatFacts)`.
  - `attributed` becomes `seatFacts.filter((f) => f.employeeId).length`; `queued` becomes `rows.length - attributed`.
  - `row_counts` becomes `{ members: rows.length, seats: rows.length, attributed, queued }`.

- [ ] **Step 4: Update the component**

In `src/components/chatgpt-import.tsx`:
- Delete the `rate` state (line 20) and the "USD / credit" label+input (lines 61-64).
- `onPreview`: `setPreview(await previewChatGptImport(text))`.
- Preview table: drop the "USD" `<th>` and the USD `<td>`; keep the Credits column (read-only reference).
- Add under the table header row a hint: change the Credits `<th>` to `Credits (not imported)`.
- Commit button label: `` `Commit ${preview.rows.length} seats` `` (remove `formatUsd(preview.totalUsd)`); remove the now-unused `formatUsd` import.
- Result message: `Imported {result.seats} seats — {result.attributed} matched to employees, {result.queued} queued for review.`

- [ ] **Step 5: Verify**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ingest/parsers/chatgpt-clipboard.ts src/lib/ingest/parsers/chatgpt-clipboard.test.ts src/app/\(dashboard\)/imports/actions.ts src/components/chatgpt-import.tsx
git commit -m "feat: ChatGPT paste import is seats-only (overage moves to the credits CSV)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Imports-page card — upload, editable rate, imported-through, source instructions

**Files:**
- Create: `src/components/openai-credits-import.tsx`
- Modify: `src/app/(dashboard)/imports/page.tsx`

**Interfaces:**
- Consumes: `previewOpenAiCreditsImport`, `commitOpenAiCreditsImport`, types (Task 4); `formatUsd` from `@/lib/utils`.
- Produces: `<OpenAiCreditsImport importedThrough={string | null} defaultRate={number} />`.

- [ ] **Step 1: Write the component**

```tsx
// src/components/openai-credits-import.tsx
"use client";

import { useState, useTransition } from "react";
import {
  previewOpenAiCreditsImport,
  commitOpenAiCreditsImport,
  type OpenAiCreditsPreview,
  type OpenAiCreditsCommitResult,
} from "@/app/(dashboard)/imports/actions";
import { formatUsd } from "@/lib/utils";

export function OpenAiCreditsImport({
  importedThrough,
  defaultRate,
}: {
  importedThrough: string | null;
  defaultRate: number;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [rate, setRate] = useState(String(defaultRate));
  const [preview, setPreview] = useState<OpenAiCreditsPreview | null>(null);
  const [result, setResult] = useState<OpenAiCreditsCommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onFile = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  const onPreview = () =>
    run(async () => {
      setResult(null);
      setPreview(await previewOpenAiCreditsImport(text, Number(rate) || 0));
    });

  const onCommit = () =>
    run(async () => {
      if (!preview) return;
      setResult(await commitOpenAiCreditsImport(preview.facts, Number(rate) || 0, fileName));
      setPreview(null);
      setText("");
      setFileName(null);
    });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        {importedThrough ? (
          <>Data imported through <span className="font-medium text-foreground">{importedThrough}</span>. A fresh export should cover from before that date — overlaps are replaced, not double-counted.</>
        ) : (
          <>No credits data imported yet.</>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="cursor-pointer rounded-md border border-border bg-surface-2 px-3 py-1.5 text-muted hover:text-foreground">
          {fileName ?? "Choose CSV…"}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </label>
        <label className="flex items-center gap-2 text-muted">
          USD / credit
          <input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
          />
        </label>
        <button
          onClick={onPreview}
          disabled={pending || !text.trim()}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-accent disabled:opacity-40"
        >
          {pending ? "Parsing…" : "Preview"}
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">
          Failed: {error}
        </p>
      )}

      {result && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Imported {result.written} facts covering {result.from} → {result.to} — {result.attributed} attributed, {result.queued} queued for review.
        </p>
      )}

      {preview && (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {preview.minDay} → {preview.maxDay} · {preview.users.length} people · {preview.modelCount} models ·{" "}
            {Math.round(preview.totalCredits).toLocaleString()} credits = {formatUsd(preview.totalUsd)} ·{" "}
            {preview.matchedCount} matched
            {preview.errors.length > 0 && ` · ${preview.errors.length} bad rows skipped`}
          </p>
          <div className="max-h-96 overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-medium">Person</th>
                  <th className="px-3 py-2 text-right font-medium">Credits</th>
                  <th className="px-3 py-2 text-right font-medium">USD</th>
                  <th className="px-3 py-2 font-medium">Employee</th>
                </tr>
              </thead>
              <tbody>
                {preview.users.map((u) => (
                  <tr key={u.email} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">
                      {u.name}
                      <div className="text-xs text-muted">{u.email}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{Math.round(u.credits).toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatUsd(u.usd)}</td>
                    <td className="px-3 py-2">
                      {u.matched ? (
                        <span className="text-emerald-300">{u.employeeName}</span>
                      ) : (
                        <span className="rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] uppercase text-pink-300">no employee</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onCommit}
              disabled={pending}
              className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-300 disabled:opacity-40"
            >
              {pending ? "Committing…" : `Commit ${preview.facts.length} facts (${formatUsd(preview.totalUsd)})`}
            </button>
            <span className="text-xs text-muted">
              Unmatched people import unattributed and surface in the Data Health queue.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the page**

In `src/app/(dashboard)/imports/page.tsx`:

1. Add the import: `import { OpenAiCreditsImport } from "@/components/openai-credits-import";`
2. Fetch the card's meta inside `ImportsPage` (after the coverage fetch; `supabase` = `getSupabaseAdminClient()` — hoist the client into a const shared with the coverage call):

```ts
  const supabase = getSupabaseAdminClient();
  const { facts, imports } = await getImportCoverageScope(supabase);
  const coverage = buildImportCoverage(facts, imports, new Date().toISOString().slice(0, 7));
  // Last successful credits-CSV import: drives the card's "imported through"
  // line and the rate prefill. Single row — no pagination needed.
  const { data: lastCsv } = await supabase
    .from("imports")
    .select("data_as_of, row_counts")
    .eq("source", "chatgpt_business")
    .eq("kind", "csv")
    .eq("status", "success")
    .order("created_at", { ascending: false })
    .limit(1);
  const importedThrough = (lastCsv?.[0]?.data_as_of as string | undefined) ?? null;
  const lastRate = (lastCsv?.[0]?.row_counts as { usd_per_credit?: number } | null)?.usd_per_credit;
  const defaultRate = typeof lastRate === "number" && lastRate > 0 ? lastRate : 0.04;
```

3. Add the panel directly after the "ChatGPT Business — workspace analytics" panel:

```tsx
        <Panel>
          <h2 className="mb-1 text-sm font-medium">ChatGPT Business — credit usage (CSV)</h2>
          <p className="mb-4 text-xs text-muted">
            Additional (paid) credits per person, day, and model — this is the source of ChatGPT overage.{" "}
            <span className="text-foreground">
              Get the file at{" "}
              <a href="https://chatgpt.com/admin/billing" target="_blank" rel="noreferrer" className="underline">
                chatgpt.com/admin/billing
              </a>{" "}
              → <strong>Credits balance</strong> → ⋮ → <strong>Download usage data</strong>.
            </span>{" "}
            The export lags a day or two (the menu shows its &ldquo;Updated&rdquo; date). Any date range is fine — rows
            carry their own dates and re-imports replace overlaps.
          </p>
          <OpenAiCreditsImport importedThrough={importedThrough} defaultRate={defaultRate} />
        </Panel>
```

4. Update the existing ChatGPT panel copy (lines 50-56) to match the seats-only paste:

```tsx
          <p className="mb-4 text-xs text-muted">
            Paste the analytics table. Each listed member is a $25 seat — credits shown in the preview are for
            reference only; paid credit overage comes from the credits CSV below. Fuzzy name-matched (no email).
          </p>
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint && CI=true npm run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/openai-credits-import.tsx src/app/\(dashboard\)/imports/page.tsx
git commit -m "feat: OpenAI credit-usage CSV card on the Imports page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: coverage table — split ChatGPT into seats and credits columns

**Files:**
- Modify: `src/lib/queries/import-coverage.ts`
- Modify: `src/lib/queries/import-coverage.test.ts`
- Modify: `src/components/import-coverage.tsx`

**Interfaces:**
- Consumes: existing `buildImportCoverage` / `CoverageMonthRow`.
- Produces: `CoverageMonthRow` becomes `{ month, chatgptSeats, chatgptCredits, claudeSpend, claudeSeats }` (the `chatgpt` field is renamed/split; `ColumnKey` gains `"chatgptCredits"`).

- [ ] **Step 1: Update the tests (failing)**

In `src/lib/queries/import-coverage.test.ts`:

- In the second test, replace the merged-chatgpt expectations:

```ts
    expect(rows[2].chatgptSeats).toEqual({ totalUsd: 25, lastImport: null });
    expect(rows[2].chatgptCredits).toEqual({ totalUsd: 10, lastImport: null });
```
  (replacing `expect(rows[2].chatgpt).toEqual({ totalUsd: 35, lastImport: null });`), and update the empty-month literal:

```ts
    expect(rows[1]).toEqual({ month: "2026-06", chatgptSeats: null, chatgptCredits: null, claudeSpend: null, claudeSeats: null });
```

- In the third test, the default `fact({ day: "2026-06-01" })` is a chatgpt overage fact and the default `log({})` is `kind: "clipboard"` → seats. Replace the chatgpt assertion with both columns and add a csv log row:

```ts
      [
        log({ createdAt: "2026-06-10T09:00:00Z" }),
        log({ createdAt: "2026-06-20T09:00:00Z" }), // later success wins
        log({ createdAt: "2026-06-25T09:00:00Z", status: "failed" }), // ignored
        log({ kind: "csv", createdAt: "2026-06-22T09:00:00Z" }), // credits CSV
        log({ source: "claude_team", kind: "csv", createdAt: "2026-06-05T12:00:00Z" }),
      ],
```

```ts
    expect(rows[0].chatgptCredits?.lastImport).toBe("2026-06-22");
    expect(rows[0].chatgptSeats).toBeNull(); // no seat facts this month → no cell
```
  (replace `expect(rows[0].chatgpt?.lastImport).toBe("2026-06-20");`; note a column with an import log but no facts stays null — that is existing behavior, cells come from facts.)

Run: `npx vitest run src/lib/queries/import-coverage.test.ts`
Expected: FAIL.

- [ ] **Step 2: Update the builder**

In `src/lib/queries/import-coverage.ts`:

```ts
export interface CoverageMonthRow {
  month: string; // YYYY-MM
  chatgptSeats: CoverageCell | null;   // chatgpt_business seats (paste import)
  chatgptCredits: CoverageCell | null; // chatgpt_business overage (credits CSV)
  claudeSpend: CoverageCell | null;    // claude_team overage
  claudeSeats: CoverageCell | null;    // claude_team seats
}

type ColumnKey = "chatgptSeats" | "chatgptCredits" | "claudeSpend" | "claudeSeats";

const factColumn = (r: CoverageFactRow): ColumnKey =>
  r.source === "chatgpt_business"
    ? (r.costType === "seat" ? "chatgptSeats" : "chatgptCredits")
    : (r.costType === "seat" ? "claudeSeats" : "claudeSpend");

const importColumn = (r: CoverageImportRow): ColumnKey | null => {
  if (r.source === "chatgpt_business") return r.kind === "csv" ? "chatgptCredits" : "chatgptSeats";
  if (r.source === "claude_team") return r.kind === "csv" ? "claudeSeats" : "claudeSpend";
  return null;
};
```

And the return mapping in `buildImportCoverage`:

```ts
    .map((month) => ({
      month,
      chatgptSeats: cell(month, "chatgptSeats"),
      chatgptCredits: cell(month, "chatgptCredits"),
      claudeSpend: cell(month, "claudeSpend"),
      claudeSeats: cell(month, "claudeSeats"),
    }));
```

- [ ] **Step 3: Update the component**

In `src/components/import-coverage.tsx`, replace the ChatGPT header/cell:

```tsx
            <th className="px-3 py-2 font-medium">ChatGPT seats</th>
            <th className="px-3 py-2 font-medium">ChatGPT credits</th>
```

```tsx
              <td className="px-3 py-2"><Cell cell={r.chatgptSeats} /></td>
              <td className="px-3 py-2"><Cell cell={r.chatgptCredits} /></td>
```

- [ ] **Step 4: Verify**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/import-coverage.ts src/lib/queries/import-coverage.test.ts src/components/import-coverage.tsx
git commit -m "feat: coverage table splits ChatGPT into seats and credits columns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: changelog + full verification

**Files:**
- Modify: `src/lib/changelog.ts`

- [ ] **Step 1: Add the changelog entry** (newest first, at the top of `CHANGELOG`):

```ts
  {
    date: "2026-07-13",
    title: "ChatGPT credit usage, per person per day",
    items: [
      "New import: the OpenAI credit-usage CSV (from the admin billing page) brings daily, per-person, per-model ChatGPT credit spend into the dashboard — Codex vs chat usage is now visible everywhere.",
      "ChatGPT overage now counts only additional (paid) credits — bundled seat credits are no longer misbooked as extra spend.",
      "The ChatGPT paste import now handles seats only, and the import-coverage table shows seats and credits separately.",
      "The credits import card shows how far imported data reaches and where to download the export.",
    ],
  },
```

- [ ] **Step 2: Full verification**

Run: `npm run test && npm run lint && CI=true npm run build`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/changelog.ts
git commit -m "docs: changelog entry for the ChatGPT credit-usage import

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand back to the user**

Do NOT merge, push, or deploy — per repo convention, report that the branch `openai-credits-import` is ready, and remind the user that after deploy the first real import (the full-year CSV at $0.04/credit) will replace historical paste overage for covered months.
