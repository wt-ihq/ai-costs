import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncOpenRouter } from "./run-openrouter";
import { openRouterActivityFixture, openRouterAnalyticsFixture } from "@/lib/ingest/fixtures/openrouter";

/**
 * Stateful fake covering every table syncOpenRouter touches: sync_runs,
 * raw_payloads, employees (select().order().range()) and spend_facts
 * (upsert / select-filter-chain / delete-in), modeled on fakeVercelDb.
 */
function fakeOpenRouterDb(
  initialSpendFacts: Record<string, unknown>[],
  employees: { id: string; email: string }[] = [],
) {
  const spendRows: Record<string, unknown>[] = initialSpendFacts.map((r, i) => ({ id: `seed${i}`, ...r }));
  let nextId = 0;
  let runId = 0;
  const syncRunUpdates: Record<string, unknown>[] = [];

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
    delete: () => ({
      in: (_c: string, ids: string[]) => {
        for (const id of ids) {
          const i = spendRows.findIndex((r) => r.id === id);
          if (i >= 0) spendRows.splice(i, 1);
        }
        return Promise.resolve({ error: null });
      },
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
            update: (patch: Record<string, unknown>) => {
              syncRunUpdates.push(patch);
              return { eq: () => Promise.resolve({ error: null }) };
            },
          };
        case "raw_payloads":
          return { insert: () => Promise.resolve({ error: null }) };
        case "employees":
          return {
            select: () => ({
              order: () => ({
                range: (from: number, to: number) => Promise.resolve({ data: employees.slice(from, to + 1), error: null }),
              }),
            }),
          };
        case "spend_facts":
          return spendFactsTable();
        default:
          throw new Error(`fakeOpenRouterDb: unexpected table "${table}"`);
      }
    },
  } as unknown as SupabaseClient;

  return { client, spendRows, syncRunUpdates };
}

const window = { startDate: "2026-07-01", endDate: "2026-08-01" };
const gareth = { id: "emp-1", email: "gareth.jones@intenthq.com" };

describe("syncOpenRouter", () => {
  it("writes attributed facts with tokens/requests and heals the activity remainder", async () => {
    const { client, spendRows } = fakeOpenRouterDb([], [gareth]);

    const result = await syncOpenRouter(client, window, async () => openRouterAnalyticsFixture, async () => openRouterActivityFixture);

    const attributed = spendRows.find((r) => r.day === "2026-07-01" && r.model === "anthropic/claude-sonnet-4-6");
    expect(attributed).toMatchObject({
      source: "openrouter",
      cost_type: "metered",
      entity_key: "gareth.jones@intenthq.com",
      cost_usd: 12.5,
      tokens: 250000,
      requests: 40,
      employee_id: "emp-1",
    });

    // Analytics under-report on 07-02 healed to /activity's day total.
    const remainder = spendRows.find((r) => r.day === "2026-07-02" && r.entity_key === "unkeyed" && r.model === "");
    expect(Number(remainder?.cost_usd)).toBeCloseTo(0.6, 5);

    expect(result.unmatched).toContain("contractor@external.dev");
    expect(result.unmatched).toContain("unkeyed");
    expect(result.unmatched).not.toContain("gareth.jones@intenthq.com");
  });

  it("no-ops on an empty analytics snapshot: seeded fact survives (gotcha #4)", async () => {
    const seeded = {
      source: "openrouter", day: "2026-07-10", cost_type: "metered",
      entity_key: "gareth.jones@intenthq.com", model: "openai/gpt-5.2", cost_usd: 4, employee_id: "emp-1",
    };
    const { client, spendRows } = fakeOpenRouterDb([seeded], [gareth]);

    const result = await syncOpenRouter(client, window, async () => ({ data: { data: [] } }), async () => ({ data: [] }));

    expect(result.rowsWritten).toBe(0);
    expect(spendRows.some((r) => r.entity_key === "gareth.jones@intenthq.com")).toBe(true);
  });

  it("still succeeds when the activity cross-check fails — facts are analytics-only", async () => {
    const { client, spendRows } = fakeOpenRouterDb([], [gareth]);

    const result = await syncOpenRouter(client, window, async () => openRouterAnalyticsFixture, async () => {
      throw new Error("activity 503");
    });

    expect(result.rowsWritten).toBeGreaterThan(0);
    expect(spendRows.some((r) => r.day === "2026-07-02" && r.entity_key === "unkeyed" && r.model === "")).toBe(false);
  });

  it("marks the run failed and rethrows when the analytics fetch fails", async () => {
    const { client, syncRunUpdates } = fakeOpenRouterDb([], [gareth]);

    await expect(
      syncOpenRouter(client, window, async () => { throw new Error("analytics truncated"); }, async () => ({ data: [] })),
    ).rejects.toThrow("analytics truncated");
    expect(syncRunUpdates.at(-1)).toMatchObject({ status: "failed" });
  });
});
