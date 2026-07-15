import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelFetcher } from "@/lib/ingest/sources/vercel";
import { syncVercel } from "./run-vercel";

/**
 * Stateful fake covering every table syncVercel touches: sync_runs,
 * raw_payloads, vercel_projects (upsert + select().limit), and spend_facts
 * (upsert / select-filter-chain / delete-in), modeled on fakeChatGptSeatsDb
 * in run-chatgpt-seats.test.ts.
 */
function fakeVercelDb(
  initialSpendFacts: Record<string, unknown>[],
  initialVercelProjects: Record<string, unknown>[] = [],
) {
  const spendRows: Record<string, unknown>[] = initialSpendFacts.map((r, i) => ({ id: `seed${i}`, ...r }));
  const projectRows: Record<string, unknown>[] = [...initialVercelProjects];
  const projectUpsertCalls: Record<string, unknown>[][] = [];
  let nextId = 0;
  let runId = 0;

  const spendFactsTable = () => ({
    upsert: (incoming: Record<string, unknown>[]) => {
      for (const r of incoming) {
        const key = (x: Record<string, unknown>) => `${x.source}|${x.day}|${x.cost_type}|${x.entity_key}|${x.model}`;
        const idx = spendRows.findIndex((x) => key(x) === key(r));
        if (idx >= 0) spendRows[idx] = { ...spendRows[idx], ...r };
        else spendRows.push({ id: `new${nextId++}`, ...r });
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
          Promise.resolve({ data: spendRows.filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }),
      };
      return q;
    },
    delete: () => {
      const builder = {
        in: (_c: string, ids: string[]) => {
          for (const id of ids) {
            const i = spendRows.findIndex((r) => r.id === id);
            if (i >= 0) spendRows.splice(i, 1);
          }
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  });

  const vercelProjectsTable = () => ({
    upsert: (incoming: Record<string, unknown>[]) => {
      projectUpsertCalls.push(incoming);
      for (const r of incoming) {
        const idx = projectRows.findIndex((x) => x.project_id === r.project_id);
        if (idx >= 0) projectRows[idx] = { ...projectRows[idx], ...r };
        else projectRows.push({ ...r });
      }
      return Promise.resolve({ error: null });
    },
    select: () => ({
      limit: () => Promise.resolve({ data: projectRows, error: null }),
    }),
  });

  const client = {
    from: (table: string) => {
      switch (table) {
        case "sync_runs":
          return {
            insert: () => ({
              select: () => ({ single: () => Promise.resolve({ data: { id: `run${runId++}` }, error: null }) }),
            }),
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        case "raw_payloads":
          return { insert: () => Promise.resolve({ error: null }) };
        case "vercel_projects":
          return vercelProjectsTable();
        case "spend_facts":
          return spendFactsTable();
        default:
          throw new Error(`fakeVercelDb: unexpected table "${table}"`);
      }
    },
  } as unknown as SupabaseClient;

  return { client, spendRows, projectRows, projectUpsertCalls };
}

const window = { startDate: "2026-07-01", endDate: "2026-08-01" };

describe("syncVercel", () => {
  // Regression lock: pins the department-attribution contract — the
  // vercel_projects upsert payload never carries `department` (so an admin's
  // assigned mapping is never clobbered by the sync), and a pre-seeded
  // mapping IS applied to the resulting spend fact.
  it("registers a project (no department in the upsert payload) and applies a pre-seeded department to the fact", async () => {
    const { client, spendRows, projectUpsertCalls } = fakeVercelDb(
      [],
      [{ project_id: "prj_abc", project_name: "ai-costs", department: "Technology" }],
    );
    const fetcher: VercelFetcher = async () => [
      {
        BilledCost: 12.5,
        ChargeCategory: "Usage",
        ChargePeriodStart: "2026-07-10T00:00:00Z",
        ServiceName: "Compute",
        Tags: { ProjectId: "prj_abc", ProjectName: "ai-costs" },
      },
    ];

    const result = await syncVercel(client, window, fetcher);

    expect(result.rowsWritten).toBe(1);
    expect(projectUpsertCalls).toHaveLength(1);
    expect(projectUpsertCalls[0]).toEqual([
      { project_id: "prj_abc", project_name: "ai-costs", updated_at: expect.any(String) },
    ]);
    for (const row of projectUpsertCalls[0]) expect(row).not.toHaveProperty("department");

    const written = spendRows.find((r) => r.source === "vercel" && r.entity_key === "ai-costs");
    expect(written).toBeDefined();
    expect(written?.department).toBe("Technology");
    expect(written?.cost_usd).toBe(12.5);
  });

  // Regression lock: gotcha #4 — a transient empty fetch must never wipe an
  // existing window's facts.
  it("no-ops on an empty fetch: seeded fact survives, run finishes success with rowsWritten 0", async () => {
    const { client, spendRows } = fakeVercelDb([
      {
        source: "vercel", day: "2026-07-10", cost_type: "metered",
        entity_key: "ai-costs", model: "Compute", cost_usd: 12.5, employee_id: null, department: "Technology",
      },
    ]);
    const emptyFetcher: VercelFetcher = async () => [];

    const result = await syncVercel(client, window, emptyFetcher);

    expect(result.rowsWritten).toBe(0);
    const keys = spendRows.map((r) => `${r.source}|${r.entity_key}`);
    expect(keys).toContain("vercel|ai-costs"); // survives
  });
});
