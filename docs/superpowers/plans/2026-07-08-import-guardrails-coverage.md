# Import Guardrails + Coverage View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the calendar-month import protocol explicit in the ChatGPT import UI, refuse empty commits before month-deletes, and add an "Import coverage" table showing which months have data per manual source.

**Architecture:** A pure `buildImportCoverage` shaper (unit-tested) over two paginated reads (`spend_facts` for the two manual sources + the `imports` audit log) feeds a server-rendered table on the Imports page. Guardrails are copy changes plus early throws in the two commit actions that delete-then-insert.

**Tech Stack:** Next.js server components, Supabase JS, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-08-import-guardrails-coverage-design.md`

## Global Constraints

- Empty-commit guard message is exactly `"Nothing to import — the preview has no rows."` and must run **before** any delete.
- Both paginated reads use `.order(...).order("id")` + `.range()` loops (gotcha #1).
- `lastImport` only counts `status === "success"` log rows; claude_team maps `kind=csv` → seats, else spend.
- Working branch: `import-guardrails-coverage`. `npm run test` before each commit; `CI=true npm run build` before finishing.

---

### Task 1: Coverage query + shaper

**Files:**
- Create: `src/lib/queries/import-coverage.ts`
- Test: `src/lib/queries/import-coverage.test.ts`

**Interfaces:**
- Produces (Task 3 consumes): `getImportCoverageScope(supabase: SupabaseClient): Promise<ImportCoverageScope>` where `ImportCoverageScope = { facts: CoverageFactRow[]; imports: CoverageImportRow[] }`; `buildImportCoverage(facts: CoverageFactRow[], importLog: CoverageImportRow[], nowMonth: string): CoverageMonthRow[]` with `CoverageMonthRow = { month: string; chatgpt: CoverageCell | null; claudeSpend: CoverageCell | null; claudeSeats: CoverageCell | null }` and `CoverageCell = { totalUsd: number; lastImport: string | null }`.

- [x] **Step 1: Write the failing test**

Create `src/lib/queries/import-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildImportCoverage, type CoverageFactRow, type CoverageImportRow } from "./import-coverage";

const fact = (over: Partial<CoverageFactRow>): CoverageFactRow => ({
  day: "2026-06-01",
  source: "chatgpt_business",
  costType: "overage",
  costUsd: 10,
  ...over,
});

const log = (over: Partial<CoverageImportRow>): CoverageImportRow => ({
  source: "chatgpt_business",
  kind: "clipboard",
  dataAsOf: "2026-06-15",
  createdAt: "2026-06-16T09:00:00Z",
  status: "success",
  ...over,
});

describe("buildImportCoverage", () => {
  it("returns [] with no facts", () => {
    expect(buildImportCoverage([], [log({})], "2026-07")).toEqual([]);
  });

  it("sums per column, fills month gaps to nowMonth, newest first", () => {
    const rows = buildImportCoverage(
      [
        fact({ day: "2026-05-01", costType: "seat", costUsd: 25 }),
        fact({ day: "2026-05-01", costType: "overage", costUsd: 10 }), // chatgpt: seat+overage merged
        fact({ day: "2026-05-01", source: "claude_team", costType: "overage", costUsd: 7 }),
        fact({ day: "2026-07-01", source: "claude_team", costType: "seat", costUsd: 30 }),
      ],
      [],
      "2026-07",
    );
    expect(rows.map((r) => r.month)).toEqual(["2026-07", "2026-06", "2026-05"]);
    expect(rows[2].chatgpt).toEqual({ totalUsd: 35, lastImport: null });
    expect(rows[2].claudeSpend).toEqual({ totalUsd: 7, lastImport: null });
    expect(rows[2].claudeSeats).toBeNull();
    expect(rows[1]).toEqual({ month: "2026-06", chatgpt: null, claudeSpend: null, claudeSeats: null });
    expect(rows[0].claudeSeats).toEqual({ totalUsd: 30, lastImport: null });
  });

  it("maps lastImport per column by source/kind, latest success wins, failures ignored", () => {
    const rows = buildImportCoverage(
      [
        fact({ day: "2026-06-01" }),
        fact({ day: "2026-06-01", source: "claude_team", costType: "seat", costUsd: 30 }),
      ],
      [
        log({ createdAt: "2026-06-10T09:00:00Z" }),
        log({ createdAt: "2026-06-20T09:00:00Z" }), // later success wins
        log({ createdAt: "2026-06-25T09:00:00Z", status: "failed" }), // ignored
        log({ source: "claude_team", kind: "csv", createdAt: "2026-06-05T12:00:00Z" }),
      ],
      "2026-06",
    );
    expect(rows[0].chatgpt?.lastImport).toBe("2026-06-20");
    expect(rows[0].claudeSeats?.lastImport).toBe("2026-06-05");
    expect(rows[0].claudeSpend).toBeNull();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/queries/import-coverage.test.ts`
Expected: FAIL — cannot resolve `./import-coverage`.

- [x] **Step 3: Write the module**

Create `src/lib/queries/import-coverage.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CostType } from "@/lib/types";

/** One manual-source fact, trimmed to what the coverage table needs. */
export interface CoverageFactRow {
  day: string; // YYYY-MM-DD
  source: "chatgpt_business" | "claude_team";
  costType: CostType;
  costUsd: number;
}

/** One `imports` audit-log row. */
export interface CoverageImportRow {
  source: string;
  kind: string; // 'csv' | 'clipboard' | 'manual'
  dataAsOf: string; // YYYY-MM-DD
  createdAt: string; // ISO timestamp
  status: string;
}

export interface CoverageCell {
  totalUsd: number;
  lastImport: string | null; // YYYY-MM-DD of the latest successful import
}

export interface CoverageMonthRow {
  month: string; // YYYY-MM
  chatgpt: CoverageCell | null; // chatgpt_business seats + overage
  claudeSpend: CoverageCell | null; // claude_team overage
  claudeSeats: CoverageCell | null; // claude_team seats
}

export interface ImportCoverageScope {
  facts: CoverageFactRow[];
  imports: CoverageImportRow[];
}

type ColumnKey = "chatgpt" | "claudeSpend" | "claudeSeats";

const factColumn = (r: CoverageFactRow): ColumnKey =>
  r.source === "chatgpt_business" ? "chatgpt" : r.costType === "seat" ? "claudeSeats" : "claudeSpend";

const importColumn = (r: CoverageImportRow): ColumnKey | null => {
  if (r.source === "chatgpt_business") return "chatgpt";
  if (r.source === "claude_team") return r.kind === "csv" ? "claudeSeats" : "claudeSpend";
  return null;
};

/** Inclusive ascending list of YYYY-MM months. */
function monthSeq(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Pure: month × source coverage grid from facts + the imports audit log. */
export function buildImportCoverage(
  facts: CoverageFactRow[],
  importLog: CoverageImportRow[],
  nowMonth: string,
): CoverageMonthRow[] {
  if (!facts.length) return [];

  const totals = new Map<string, number>(); // `${month}:${col}` -> USD
  let earliest = facts[0].day.slice(0, 7);
  for (const f of facts) {
    const month = f.day.slice(0, 7);
    if (month < earliest) earliest = month;
    const key = `${month}:${factColumn(f)}`;
    totals.set(key, (totals.get(key) ?? 0) + f.costUsd);
  }

  const lastImports = new Map<string, string>(); // `${month}:${col}` -> YYYY-MM-DD
  for (const imp of importLog) {
    if (imp.status !== "success") continue;
    const col = importColumn(imp);
    if (!col) continue;
    const key = `${imp.dataAsOf.slice(0, 7)}:${col}`;
    const day = imp.createdAt.slice(0, 10);
    const prev = lastImports.get(key);
    if (!prev || day > prev) lastImports.set(key, day);
  }

  const cell = (month: string, col: ColumnKey): CoverageCell | null => {
    const total = totals.get(`${month}:${col}`);
    if (total === undefined) return null;
    return { totalUsd: Math.round(total * 100) / 100, lastImport: lastImports.get(`${month}:${col}`) ?? null };
  };

  return monthSeq(earliest, nowMonth)
    .reverse()
    .map((month) => ({
      month,
      chatgpt: cell(month, "chatgpt"),
      claudeSpend: cell(month, "claudeSpend"),
      claudeSeats: cell(month, "claudeSeats"),
    }));
}

/** Fetch the manual-source facts + imports log (both paginated, gotcha #1). */
export async function getImportCoverageScope(supabase: SupabaseClient): Promise<ImportCoverageScope> {
  const PAGE = 1000;

  const facts: CoverageFactRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("day, source, cost_type, cost_usd")
      .in("source", ["chatgpt_business", "claude_team"])
      .order("day")
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`getImportCoverageScope: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      facts.push({
        day: r.day as string,
        source: r.source as CoverageFactRow["source"],
        costType: r.cost_type as CostType,
        costUsd: Number(r.cost_usd),
      });
    }
    if (data.length < PAGE) break;
  }

  const imports: CoverageImportRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("imports")
      .select("source, kind, data_as_of, created_at, status")
      .order("created_at")
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`getImportCoverageScope (imports): ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      imports.push({
        source: r.source as string,
        kind: r.kind as string,
        dataAsOf: r.data_as_of as string,
        createdAt: r.created_at as string,
        status: r.status as string,
      });
    }
    if (data.length < PAGE) break;
  }

  return { facts, imports };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/queries/import-coverage.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add src/lib/queries/import-coverage.ts src/lib/queries/import-coverage.test.ts
git commit -m "feat: import-coverage query + shaper"
```

---

### Task 2: Guardrails — empty-commit guards + calendar-month copy

**Files:**
- Modify: `src/app/(dashboard)/imports/actions.ts` (two commit actions)
- Modify: `src/components/chatgpt-import.tsx` (label)
- Modify: `src/app/(dashboard)/imports/page.tsx` (panel copy)

- [x] **Step 1: Guard the delete-then-insert commits**

In `src/app/(dashboard)/imports/actions.ts`:

In `commitChatGptImport`, immediately after `const supabase = getSupabaseAdminClient();` add:

```ts
  // Never delete a month when the insert would be empty (gotcha #4).
  if (!rows.length) throw new Error("Nothing to import — the preview has no rows.");
```

In `commitClaudeRoster`, immediately after `const supabase = getSupabaseAdminClient();` add the same two lines.

- [x] **Step 2: Relabel "Data as of" → "Month"**

In `src/components/chatgpt-import.tsx`, change the label text:

```tsx
        <label className="flex items-center gap-2 text-muted">
          Month
```

(keep the date input and comment as they are).

- [x] **Step 3: Panel copy with the export rule**

In `src/app/(dashboard)/imports/page.tsx`, replace the ChatGPT panel description paragraph with:

```tsx
          <p className="mb-4 text-xs text-muted">
            Paste the analytics table. Each listed member is a $25 seat; credits become overage. Fuzzy name-matched (no email).{" "}
            <span className="text-foreground">
              Export a <strong>Custom</strong> range covering exactly one calendar month — the 1M preset is a rolling
              30-day window and double-counts across months.
            </span>
          </p>
```

- [x] **Step 4: Lint, typecheck, commit**

Run: `npm run lint && npx tsc --noEmit` — clean.

```bash
git add "src/app/(dashboard)/imports/actions.ts" src/components/chatgpt-import.tsx "src/app/(dashboard)/imports/page.tsx"
git commit -m "fix: empty-commit guards + calendar-month export guidance on imports"
```

---

### Task 3: Coverage table on the Imports page + changelog

**Files:**
- Create: `src/components/import-coverage.tsx`
- Modify: `src/app/(dashboard)/imports/page.tsx`
- Modify: `src/lib/changelog.ts`

**Interfaces:**
- Consumes: `getImportCoverageScope`, `buildImportCoverage`, `CoverageMonthRow`, `CoverageCell` (Task 1); `formatUsd`; `getSupabaseAdminClient`.

- [x] **Step 1: Write the table component (server)**

Create `src/components/import-coverage.tsx`:

```tsx
import type { CoverageCell, CoverageMonthRow } from "@/lib/queries/import-coverage";
import { formatUsd } from "@/lib/utils";

function Cell({ cell }: { cell: CoverageCell | null }) {
  if (!cell) return <span className="text-muted">—</span>;
  return (
    <span>
      <span className="tabular-nums">{formatUsd(cell.totalUsd)}</span>
      {cell.lastImport && <span className="ml-2 text-xs text-muted">imported {cell.lastImport}</span>}
    </span>
  );
}

/** Month × manual-source coverage grid — makes import gaps visible. */
export function ImportCoverage({ rows }: { rows: CoverageMonthRow[] }) {
  if (!rows.length) return <p className="text-sm text-muted">No manual imports yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th className="px-3 py-2 font-medium">Month</th>
            <th className="px-3 py-2 font-medium">ChatGPT Business</th>
            <th className="px-3 py-2 font-medium">Claude spend</th>
            <th className="px-3 py-2 font-medium">Claude seats</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className="border-b border-border/60 last:border-0">
              <td className="px-3 py-2 font-medium">{r.month}</td>
              <td className="px-3 py-2"><Cell cell={r.chatgpt} /></td>
              <td className="px-3 py-2"><Cell cell={r.claudeSpend} /></td>
              <td className="px-3 py-2"><Cell cell={r.claudeSeats} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [x] **Step 2: Wire it into the Imports page**

In `src/app/(dashboard)/imports/page.tsx`, add imports:

```tsx
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildImportCoverage, getImportCoverageScope } from "@/lib/queries/import-coverage";
import { ImportCoverage } from "@/components/import-coverage";
```

After the admin check, fetch the data:

```tsx
  const { facts, imports } = await getImportCoverageScope(getSupabaseAdminClient());
  const coverage = buildImportCoverage(facts, imports, new Date().toISOString().slice(0, 7));
```

And add a new Panel as the FIRST child of the `<div className="grid gap-4">`:

```tsx
        <Panel>
          <h2 className="mb-1 text-sm font-medium">Import coverage</h2>
          <p className="mb-4 text-xs text-muted">
            Months with manually imported data, by source — a &ldquo;—&rdquo; is a gap (or a month that predates the tool).
          </p>
          <ImportCoverage rows={coverage} />
        </Panel>
```

- [x] **Step 3: Changelog**

In `src/lib/changelog.ts`, append to the `2026-07-08` entry's `items`:

```ts
      "The Imports page now shows which months each manual source has been imported for, and the ChatGPT import explains how to export a single calendar month (the rolling 1M window double-counts).",
```

- [x] **Step 4: Full verify and commit**

Run: `npm run test` — expected 134 pass (131 + 3 new).
Run: `CI=true npm run build` — succeeds.

```bash
git add src/components/import-coverage.tsx "src/app/(dashboard)/imports/page.tsx" src/lib/changelog.ts
git commit -m "feat: import-coverage table on the Imports page"
```
