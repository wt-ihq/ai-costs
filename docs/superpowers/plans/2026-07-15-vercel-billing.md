# Vercel FOCUS Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull Vercel spend (plan + metered usage) from the FOCUS billing API into `spend_facts` daily, attributed per project to a chosen department.

**Architecture:** A JSONL FOCUS fetcher + fixture-tested normalizer feed a source-isolated `vercel` sync using the standard month-to-date snapshot-replace. Projects auto-register into a `vercel_projects` mapping table; their assigned department attaches to facts at sync time (fact-level `department`, as built for recurring tools) and re-attaches historical facts on assignment. Team pages' Tools list generalizes to "Tools & infrastructure".

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Supabase, Vercel REST API (`GET /v1/billing/charges`, FOCUS v1.3 JSONL).

**Spec:** `docs/superpowers/specs/2026-07-15-vercel-billing-design.md`

## Global Constraints

- Branch off origin/main: `git checkout -b vercel-billing origin/main`.
- Cost-type mapping: `Purchase`/`Tax` → `subscription`; `Usage`/`Credit`/`Adjustment` → `metered` (negative `BilledCost` passes through). Unknown `ChargeCategory` → **throw `SchemaDriftError`** (never silently drop money); same for a malformed JSONL line or missing required fields.
- Facts: `source: "vercel"`, `day` = `ChargePeriodStart` date part, `entityKey` = `Tags.ProjectName ?? Tags.ProjectId ?? "team"`, `model` = `ServiceName`, `costUsd` = `BilledCost` (USD), `employeeId: null`, `department` from the project map (by ProjectName), aggregated per `(day, costType, entityKey, model)`.
- Windows exclusive-end; sync uses the cron's month-to-date window; backfill in monthly windows (gotcha #3); `replaceWindowFacts` snapshot semantics (gotcha #4).
- Secrets `VERCEL_BILLING_TOKEN` + `VERCEL_TEAM_ID` from env only; fetcher throws early when unset; 429/5xx retried with the Okta-style backoff.
- Project auto-registration must NEVER clobber an assigned `department` (upsert payload omits the column).
- Data Health: `source === "vercel"` facts skip the unmatched queues (same guard as `other`); the vendor row + sync cell need no fold (source name == vendor name).
- Vendor identity: `vercel` enum value, `VENDOR_LABEL.vercel = "Vercel"`, `VENDOR_COLORS.vercel = "#cbd5e1"`.
- Every `"use server"` action starts with `await requireAdmin()`. Gotcha #1 pagination for growing-table reads (`vercel_projects` list reads are bounded `.limit(200)` with a justification comment — it grows by projects, not rows-per-day).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Final: `npm run test && CI=true npm run build` pass. Do NOT merge/push/deploy. Migration 0010's `alter type` line runs alone in prod (same rule as 0008/0009).

---

### Task 1: migration 0010 + the `vercel` vendor identity

**Files:**
- Create: `supabase/migrations/0010_vercel_billing.sql`
- Modify: `src/lib/types.ts`, `src/lib/colors.ts`

**Interfaces:** `Vendor` includes `"vercel"`; `VENDOR_LABEL.vercel`, `VENDOR_COLORS.vercel`.

- [ ] **Step 1: Migration**

```sql
-- supabase/migrations/0010_vercel_billing.sql
-- NOTE (prod apply): run the ALTER TYPE line as its OWN statement first.
alter type vendor add value 'vercel';

-- Project -> department mapping for Vercel billing attribution. Projects
-- auto-register on each sync (name refreshed, department never touched);
-- admins assign departments on the Imports page.
create table vercel_projects (
  id           uuid primary key default gen_random_uuid(),
  project_id   text not null unique,
  project_name text not null,
  department   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
```

- [ ] **Step 2:** `src/lib/types.ts` — add `| "vercel"` to `Vendor`, `vercel: "Vercel",` to `VENDOR_LABEL`. `src/lib/colors.ts` — add `vercel: "#cbd5e1",` to `VENDOR_COLORS`.

- [ ] **Step 3: Verify** — `npx vitest run && npx tsc --noEmit && npm run lint` (exhaustive `Record<Vendor,…>` maps force exactly these edits; Data Health gains a "Vercel" row automatically — intended).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0010_vercel_billing.sql src/lib/types.ts src/lib/colors.ts
git commit -m "feat: vercel vendor identity + project-department mapping table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: FOCUS normalizer

**Files:**
- Create: `src/lib/ingest/normalizers/vercel.ts`
- Test: `src/lib/ingest/normalizers/vercel.test.ts`

**Interfaces:**
- Consumes: `SpendFact` from `@/lib/types`; `SchemaDriftError` from `@/lib/ingest/types` (read its constructor before using).
- Produces (used by Tasks 3–4):

```ts
export interface FocusCharge {
  BilledCost: number;
  ChargeCategory: string;   // Usage | Purchase | Credit | Adjustment | Tax
  ChargePeriodStart: string;
  ServiceName: string;
  Tags?: Record<string, string>; // ProjectId / ProjectName when project-scoped
  [k: string]: unknown;          // FOCUS carries many more fields; ignored
}
export function normalizeVercel(charges: FocusCharge[]): SpendFact[];
```

- [ ] **Step 1: Failing tests**

```ts
// src/lib/ingest/normalizers/vercel.test.ts
import { describe, expect, it } from "vitest";
import { normalizeVercel, type FocusCharge } from "./vercel";
import { SchemaDriftError } from "@/lib/ingest/types";

const charge = (over: Partial<FocusCharge>): FocusCharge => ({
  BilledCost: 1.5,
  ChargeCategory: "Usage",
  ChargePeriodStart: "2026-07-01T00:00:00Z",
  ServiceName: "Function Invocations",
  Tags: { ProjectId: "prj_abc", ProjectName: "ai-costs" },
  ...over,
});

describe("normalizeVercel", () => {
  it("maps categories to cost types and aggregates per (day, costType, entity, service)", () => {
    const facts = normalizeVercel([
      charge({}),                                   // usage → metered
      charge({ BilledCost: 0.5 }),                  // same key → aggregated
      charge({ ChargeCategory: "Purchase", ServiceName: "Pro Plan", Tags: undefined, BilledCost: 20 }),
    ]);
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.model === "Function Invocations")).toMatchObject({
      source: "vercel", day: "2026-07-01", costType: "metered",
      entityKey: "ai-costs", costUsd: 2, employeeId: null,
    });
    expect(facts.find((f) => f.model === "Pro Plan")).toMatchObject({
      costType: "subscription", entityKey: "team", costUsd: 20,
    });
  });

  it("passes negative credits through and maps Tax to subscription", () => {
    const facts = normalizeVercel([
      charge({ ChargeCategory: "Credit", BilledCost: -5, ServiceName: "Promo Credit", Tags: undefined }),
      charge({ ChargeCategory: "Tax", BilledCost: 3.1, ServiceName: "VAT", Tags: undefined }),
    ]);
    expect(facts.find((f) => f.model === "Promo Credit")).toMatchObject({ costType: "metered", costUsd: -5 });
    expect(facts.find((f) => f.model === "VAT")).toMatchObject({ costType: "subscription", costUsd: 3.1 });
  });

  it("falls back to ProjectId then 'team' for the entity key", () => {
    const facts = normalizeVercel([charge({ Tags: { ProjectId: "prj_xyz" } })]);
    expect(facts[0].entityKey).toBe("prj_xyz");
  });

  it("throws SchemaDriftError on an unknown ChargeCategory", () => {
    expect(() => normalizeVercel([charge({ ChargeCategory: "Refund" })])).toThrow(SchemaDriftError);
  });

  it("throws SchemaDriftError when required fields are missing", () => {
    expect(() => normalizeVercel([charge({ BilledCost: undefined as unknown as number })])).toThrow(SchemaDriftError);
  });
});
```

- [ ] **Step 2: RED**, then **Step 3: implement**

```ts
// src/lib/ingest/normalizers/vercel.ts
import type { CostType, SpendFact } from "@/lib/types";
import { SchemaDriftError } from "@/lib/ingest/types";

export interface FocusCharge {
  BilledCost: number;
  ChargeCategory: string;
  ChargePeriodStart: string;
  ServiceName: string;
  Tags?: Record<string, string>;
  [k: string]: unknown;
}

/** FOCUS ChargeCategory → our cost types. Unknown categories throw — money
 * must never be silently dropped or misfiled. */
const CATEGORY_TO_COST_TYPE: Record<string, CostType> = {
  Purchase: "subscription",
  Tax: "subscription",
  Usage: "metered",
  Credit: "metered",     // negative BilledCost passes through
  Adjustment: "metered",
};

/** FOCUS charges (1-day granularity) → facts per (day, costType, entity, service). */
export function normalizeVercel(charges: FocusCharge[]): SpendFact[] {
  const byKey = new Map<string, SpendFact>();
  for (const c of charges) {
    if (typeof c.BilledCost !== "number" || !c.ChargePeriodStart || !c.ChargeCategory || !c.ServiceName) {
      throw new SchemaDriftError(`vercel charge missing required fields: ${JSON.stringify(c).slice(0, 160)}`);
    }
    const costType = CATEGORY_TO_COST_TYPE[c.ChargeCategory];
    if (!costType) throw new SchemaDriftError(`vercel: unknown ChargeCategory "${c.ChargeCategory}"`);
    const day = c.ChargePeriodStart.slice(0, 10);
    const entityKey = c.Tags?.ProjectName ?? c.Tags?.ProjectId ?? "team";
    const k = `${day}|${costType}|${entityKey}|${c.ServiceName}`;
    const f = byKey.get(k) ?? {
      source: "vercel" as const, day, costType, entityKey, model: c.ServiceName, costUsd: 0, employeeId: null,
    };
    f.costUsd = Math.round((f.costUsd + c.BilledCost) * 100) / 100;
    byKey.set(k, f);
  }
  return [...byKey.values()];
}
```

(Adapt the `SchemaDriftError` constructor call to its actual signature after reading `src/lib/ingest/types.ts`.)

- [ ] **Step 4: GREEN + suite**, then **Step 5: Commit**

```bash
git add src/lib/ingest/normalizers/vercel.ts src/lib/ingest/normalizers/vercel.test.ts
git commit -m "feat: normalize Vercel FOCUS charges into spend facts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: fetcher

**Files:**
- Create: `src/lib/ingest/sources/vercel.ts`
- Test: `src/lib/ingest/sources/vercel.test.ts`

**Interfaces:**
- Consumes: `DateWindow` from `@/lib/ingest/sources/anthropic`; `FocusCharge` (Task 2); `SchemaDriftError`.
- Produces: `export type VercelFetcher = (window: DateWindow) => Promise<FocusCharge[]>;` `export const fetchVercelCharges: VercelFetcher;`

- [ ] **Step 1: Failing tests** (mirror `sources/okta.test.ts`'s fetch-stubbing style — `vi.stubGlobal("fetch", ...)`, `vi.stubEnv`, `afterEach` unstub both):

```ts
// src/lib/ingest/sources/vercel.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVercelCharges } from "./vercel";
import { SchemaDriftError } from "@/lib/ingest/types";

const textRes = (body: string, status = 200) =>
  ({ ok: status < 400, status, text: async () => body }) as unknown as Response;

const stubEnv = () => {
  vi.stubEnv("VERCEL_BILLING_TOKEN", "tok");
  vi.stubEnv("VERCEL_TEAM_ID", "team_x");
};
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const WINDOW = { startDate: "2026-07-01", endDate: "2026-08-01" };

describe("fetchVercelCharges", () => {
  it("parses the JSONL stream and passes window/team/auth", async () => {
    stubEnv();
    let seenUrl = "", seenAuth = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>).Authorization;
      return textRes('{"BilledCost":1}\n\n{"BilledCost":2}\n');
    }));
    const charges = await fetchVercelCharges(WINDOW);
    expect(charges.map((c) => c.BilledCost)).toEqual([1, 2]); // blank lines skipped
    expect(seenUrl).toContain("from=2026-07-01");
    expect(seenUrl).toContain("to=2026-08-01");
    expect(seenUrl).toContain("teamId=team_x");
    expect(seenAuth).toBe("Bearer tok");
  });

  it("throws SchemaDriftError on a malformed JSONL line", async () => {
    stubEnv();
    vi.stubGlobal("fetch", vi.fn(async () => textRes('{"BilledCost":1}\nnot-json\n')));
    await expect(fetchVercelCharges(WINDOW)).rejects.toThrow(SchemaDriftError);
  });

  it("retries 429/5xx with backoff, then succeeds", async () => {
    stubEnv();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++calls < 3 ? textRes("rate limited", 429) : textRes('{"BilledCost":1}'))));
    const charges = await fetchVercelCharges(WINDOW);
    expect(charges).toHaveLength(1);
    expect(calls).toBe(3);
  }, 15_000);

  it("throws when env vars are missing", async () => {
    vi.stubEnv("VERCEL_BILLING_TOKEN", "");
    vi.stubEnv("VERCEL_TEAM_ID", "");
    await expect(fetchVercelCharges(WINDOW)).rejects.toThrow(/VERCEL_BILLING_TOKEN/);
  });
});
```

- [ ] **Step 2: RED**, then **Step 3: implement**

```ts
// src/lib/ingest/sources/vercel.ts
import type { DateWindow } from "@/lib/ingest/sources/anthropic";
import type { FocusCharge } from "@/lib/ingest/normalizers/vercel";
import { SchemaDriftError } from "@/lib/ingest/types";

export type VercelFetcher = (window: DateWindow) => Promise<FocusCharge[]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * FOCUS v1.3 billing charges for the team, as JSONL (1-day granularity,
 * exclusive-end window — the API's convention matches ours). Retries 429/5xx
 * with exponential backoff; a malformed line throws (money is never silently
 * dropped).
 */
export const fetchVercelCharges: VercelFetcher = async (window) => {
  const token = process.env.VERCEL_BILLING_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token || !teamId) throw new Error("VERCEL_BILLING_TOKEN / VERCEL_TEAM_ID not set");

  const url = `https://api.vercel.com/v1/billing/charges?from=${window.startDate}&to=${window.endDate}&teamId=${encodeURIComponent(teamId)}`;
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/jsonl" } });
    if (res.ok) {
      const lines = (await res.text()).split("\n").filter((l) => l.trim());
      return lines.map((line) => {
        try {
          return JSON.parse(line) as FocusCharge;
        } catch {
          throw new SchemaDriftError(`vercel billing: malformed JSONL line "${line.slice(0, 120)}"`);
        }
      });
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxAttempts - 1) {
      throw new Error(`Vercel billing ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(Math.min(1000 * 2 ** attempt, 16_000));
  }
};
```

- [ ] **Step 4: GREEN + suite**, then **Step 5: Commit**

```bash
git add src/lib/ingest/sources/vercel.ts src/lib/ingest/sources/vercel.test.ts
git commit -m "feat: fetch Vercel FOCUS billing charges (JSONL, backoff)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: sync orchestrator + registration + Data Health

**Files:**
- Create: `src/lib/ingest/run-vercel.ts`
- Modify: `src/lib/ingest/run-all.ts`, `src/app/(dashboard)/imports/actions.ts` (backfill list), `src/lib/queries/data-health.ts`
- Test: `src/lib/ingest/run-vercel.test.ts`

**Interfaces:**
- Produces: `export async function syncVercel(supabase, window, fetcher?: VercelFetcher): Promise<{ rowsWritten: number }>;` plus internal `upsertVercelProjects` / `loadVercelDepartments`.

- [ ] **Step 1: Implement the orchestrator** (mirror `syncOpenAI`'s shape exactly — read `run-platforms.ts:119-139` first):

```ts
// src/lib/ingest/run-vercel.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchVercelCharges, type VercelFetcher } from "@/lib/ingest/sources/vercel";
import { normalizeVercel, type FocusCharge } from "@/lib/ingest/normalizers/vercel";
import type { DateWindow } from "@/lib/ingest/sources/anthropic";
import { finishSyncRun, replaceWindowFacts, saveRawPayload, startSyncRun, type ResolvedFact } from "@/lib/ingest/persist";

/** Register every project seen in the charges; refresh names, never touch departments. */
async function upsertVercelProjects(supabase: SupabaseClient, charges: FocusCharge[]): Promise<void> {
  const byId = new Map<string, string>();
  for (const c of charges) {
    const id = c.Tags?.ProjectId;
    if (id) byId.set(id, c.Tags?.ProjectName ?? id);
  }
  if (byId.size === 0) return;
  const rows = [...byId.entries()].map(([project_id, project_name]) => ({
    project_id, project_name, updated_at: new Date().toISOString(),
  }));
  // Payload omits `department`, so ON CONFLICT leaves an assigned mapping intact.
  const { error } = await supabase.from("vercel_projects").upsert(rows, { onConflict: "project_id" });
  if (error) throw new Error(`upsertVercelProjects: ${error.message}`);
}

/** project_name → department (assigned rows only). Bounded read — the table grows by projects, not days. */
async function loadVercelDepartments(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("vercel_projects").select("project_name, department").limit(200);
  if (error) throw new Error(`loadVercelDepartments: ${error.message}`);
  return new Map((data ?? []).filter((r) => r.department).map((r) => [r.project_name as string, r.department as string]));
}

/** Vercel FOCUS billing → spend facts, month-to-date snapshot like the other metered sources. */
export async function syncVercel(
  supabase: SupabaseClient,
  window: DateWindow,
  fetcher: VercelFetcher = fetchVercelCharges,
): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "vercel");
  try {
    const charges = await fetcher(window);
    await saveRawPayload(supabase, "vercel", runId, { charges });
    await upsertVercelProjects(supabase, charges);
    const departments = await loadVercelDepartments(supabase);
    const facts: ResolvedFact[] = normalizeVercel(charges).map((f) => ({
      ...f,
      employeeId: null,
      department: departments.get(f.entityKey) ?? null,
    }));
    const rowsWritten = await replaceWindowFacts(supabase, "vercel", window, facts);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
```

- [ ] **Step 2: Register**
- `run-all.ts`: import `syncVercel`; add `run("vercel", () => syncVercel(supabase, window)),` to the parallel block.
- `imports/actions.ts` backfill loop: add `["vercel", () => syncVercel(supabase, window)],` to the source array (import `syncVercel`).
- `data-health.ts`: extend the skip guard to `if (f.source === "other" || f.source === "vercel") continue;` (update its comment: "recurring tool costs and Vercel project charges are department-attributed — never assignable to a person"). No sync fold needed (source name == vendor name; `lastSync.get("vercel")` already works).

- [ ] **Step 3: Regression test** — `run-vercel.test.ts` with a stateful fake (adapt the harness pattern from `run-chatgpt-seats.test.ts`; chains needed: `sync_runs` insert/update, `raw_payloads` insert, `vercel_projects` upsert + select().limit, `spend_facts` upsert/select-filter-chain/delete-in):

```ts
// Core assertions:
// 1. A charge for prj_abc/ai-costs registers the project; with a PRE-SEEDED
//    vercel_projects row { project_id: "prj_abc", department: "Technology" },
//    the written fact carries department "Technology" and the upsert payload
//    did NOT include a department key (assigned mapping survives).
// 2. Injected fetcher returning [] → replaceWindowFacts no-ops (seeded vercel
//    fact survives — gotcha #4), run finishes success with rowsWritten 0.
```

Write both as real tests with the fake, asserting on the fake's stored rows.

- [ ] **Step 4: Verify + commit** — `npx vitest run && npx tsc --noEmit && npm run lint`

```bash
git add src/lib/ingest/run-vercel.ts src/lib/ingest/run-vercel.test.ts src/lib/ingest/run-all.ts src/app/\(dashboard\)/imports/actions.ts src/lib/queries/data-health.ts
git commit -m "feat: vercel sync source — daily FOCUS billing into spend facts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Tools & infrastructure on team pages

**Files:**
- Modify: `src/lib/explore/shape.ts` (`rankTools`), `src/components/explore/ranked-panel.tsx` (title)
- Test: `src/lib/explore/shape.test.ts`

**Interfaces:** `rankTools(rows, toolColors?)` — unchanged signature; now includes `source === "vercel"` person-less rows grouped by `entityKey` (label = project name, sub `"Vercel project"`); `other` rows unchanged (grouped by `model`, sub `"recurring tool subscription"`).

- [ ] **Step 1: Failing tests** (append to shape.test.ts)

```ts
describe("rankTools with Vercel projects", () => {
  const vercelFact = (entityKey: string, costUsd: number): ShapeFact => ({
    day: "2026-07-01", source: "vercel", costType: "metered", costUsd,
    employeeId: null, department: "Technology", fullName: null, entityKey, model: "Function Invocations",
  });

  it("lists Vercel projects beside recurring tools, each with the right sub", () => {
    const rows = rankTools([
      vercelFact("ai-costs", 12.5), vercelFact("ai-costs", 2.5),
      { day: "2026-07-01", source: "other", costType: "subscription", costUsd: 100, employeeId: null, department: "Technology", fullName: null, entityKey: "openrouter|Technology", model: "OpenRouter" },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["OpenRouter", "ai-costs"]); // total desc
    expect(rows.find((r) => r.label === "ai-costs")).toMatchObject({ total: 15, href: undefined });
    expect(rows.find((r) => r.label === "ai-costs")?.sub).toBe("Vercel project");
    expect(rows.find((r) => r.label === "OpenRouter")?.sub).toContain("recurring");
  });
});
```

- [ ] **Step 2: RED**, then **Step 3: implement** — rework `rankTools`'s filter/grouping:

```ts
export function rankTools(rows: ShapeFact[], toolColors?: ToolColors): RankRow[] {
  const personLess = rows.filter((r) => (r.source === "other" || r.source === "vercel") && !r.employeeId);
  const byKey = groupBy(personLess, (r) => (r.source === "vercel" ? `vercel:${r.entityKey}` : `other:${r.model}`));
  return [...byKey.entries()]
    .map(([key, toolRows]) => {
      const isVercel = key.startsWith("vercel:");
      return {
        id: `tool:${key}`,
        label: key.slice(key.indexOf(":") + 1),
        total: Math.round(sum(toolRows) * 100) / 100,
        href: undefined,
        sub: isVercel ? "Vercel project" : "recurring tool subscription",
        segments: segmentsByDim(toolRows, toolColors),
      };
    })
    .sort((a, b) => b.total - a.total);
}
```

(Keep/adjust the doc comment: person-less, department-attributed costs — recurring tools and Vercel projects.) Update the panel heading in `ranked-panel.tsx` from `Tools` to `Tools & infrastructure`.

- [ ] **Step 4: GREEN + suite** (the existing rankTools tests must still pass — labels/subs for `other` unchanged), then **Step 5: Commit**

```bash
git add src/lib/explore/shape.ts src/lib/explore/shape.test.ts src/components/explore/ranked-panel.tsx
git commit -m "feat: team pages list Vercel projects under Tools & infrastructure

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: mapping card + assignment action

**Files:**
- Modify: `src/app/(dashboard)/imports/actions.ts`
- Create: `src/components/vercel-projects.tsx`
- Modify: `src/app/(dashboard)/imports/page.tsx`

**Interfaces:**

```ts
export async function assignVercelProjectDepartment(projectId: string, department: string | null): Promise<{ factsUpdated: number }>;
export interface VercelProjectRow { projectId: string; projectName: string; department: string | null }
```

- [ ] **Step 1: Action**

```ts
// ---- Vercel project → department mapping ------------------------------------

/** Assign (or clear) a project's department and re-attach its existing facts. */
export async function assignVercelProjectDepartment(
  projectId: string,
  department: string | null,
): Promise<{ factsUpdated: number }> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const dept = department?.trim() || null;

  const { data: rows, error: readErr } = await supabase
    .from("vercel_projects").select("project_name").eq("project_id", projectId).limit(1);
  if (readErr) throw new Error(`assignVercelProjectDepartment: ${readErr.message}`);
  const projectName = rows?.[0]?.project_name as string | undefined;
  if (!projectName) throw new Error("Project not found.");

  const { error: updErr } = await supabase
    .from("vercel_projects")
    .update({ department: dept, updated_at: new Date().toISOString() })
    .eq("project_id", projectId);
  if (updErr) throw new Error(`assignVercelProjectDepartment: ${updErr.message}`);

  // Re-attach history in place: backfilled months aren't re-synced nightly,
  // so the department must follow the mapping immediately.
  const { error: factErr, count } = await supabase
    .from("spend_facts")
    .update({ department: dept }, { count: "exact" })
    .eq("source", "vercel")
    .eq("entity_key", projectName);
  if (factErr) throw new Error(`assignVercelProjectDepartment facts: ${factErr.message}`);

  revalidatePath("/imports");
  revalidatePath("/");
  return { factsUpdated: count ?? 0 };
}
```

- [ ] **Step 2: Component** `src/components/vercel-projects.tsx` — follow the existing card patterns (`useTransition`, error/success panes). Props `{ projects: VercelProjectRow[]; departments: string[] }`. One row per project: name, a text input with the shared departments `<datalist>` (initial value = current department), Save button per row calling `assignVercelProjectDepartment(p.projectId, value || null)`; success pane reports "ai-costs → Technology — N facts re-attributed". Empty state: "No projects yet — they appear after the first Vercel sync."

- [ ] **Step 3: Page wiring** — fetch in `imports/page.tsx` (`departments` already derived there from Task 7 of the recurring feature — reuse it):

```ts
  const { data: vercelRows } = await supabase
    .from("vercel_projects")
    .select("project_id, project_name, department")
    .order("project_name")
    .limit(200); // bounded: grows by projects, not rows-per-day
  const vercelProjects: VercelProjectRow[] = (vercelRows ?? []).map((r) => ({
    projectId: r.project_id as string,
    projectName: r.project_name as string,
    department: (r.department as string) ?? null,
  }));
```

New Panel after the "Other AI tools" panel:

```tsx
        <Panel>
          <h2 className="mb-1 text-sm font-medium">Vercel projects</h2>
          <p className="mb-4 text-xs text-muted">
            Vercel spend syncs nightly per project. Assign each project to a department to place its cost on
            that team&rsquo;s row — unassigned projects (and team-level charges like the plan fee) show under
            Unattributed. Projects appear here automatically after each sync.
          </p>
          <VercelProjects projects={vercelProjects} departments={departments} />
        </Panel>
```

- [ ] **Step 4: Verify + commit** — `npx vitest run && npx tsc --noEmit && npm run lint && CI=true npm run build`

```bash
git add src/app/\(dashboard\)/imports/actions.ts src/components/vercel-projects.tsx src/app/\(dashboard\)/imports/page.tsx
git commit -m "feat: Vercel project-department mapping card

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: changelog + full verification

**Files:**
- Modify: `src/lib/changelog.ts`

- [ ] **Step 1: Prepend a new entry** (today is a new day — new entry above `2026-07-14`):

```ts
  {
    date: "2026-07-15",
    title: "Vercel spend, synced daily",
    items: [
      "Vercel hosting costs now flow in automatically from Vercel's billing API — plan charges as Subscription, usage as API, per project per day.",
      "Assign each Vercel project to a department on the Imports page and its cost lands on that team's row; team pages list projects under 'Tools & infrastructure' beside recurring tools.",
    ],
  },
```

- [ ] **Step 2: Full verify** — `npm run test && npm run lint && CI=true npm run build`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/changelog.ts
git commit -m "docs: changelog for Vercel billing sync

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand back** — do NOT merge/push/deploy. Remind the user: (1) migration 0010 (enum line alone first); (2) create a Vercel token with billing read for jml-ihq and set `VERCEL_BILLING_TOKEN` + `VERCEL_TEAM_ID` in the Vercel env; (3) after deploy: manual sync → assign departments on the new card → backfill up to 12 months from the Imports page.
