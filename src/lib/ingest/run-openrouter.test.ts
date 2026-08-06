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
  initialWorkspaces: Record<string, unknown>[] = [],
) {
  const spendRows: Record<string, unknown>[] = initialSpendFacts.map((r, i) => ({ id: `seed${i}`, ...r }));
  const workspaceRows: Record<string, unknown>[] = [...initialWorkspaces];
  const workspaceUpserts: Record<string, unknown>[][] = [];
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
        case "openrouter_workspaces":
          return {
            select: () => ({ limit: () => Promise.resolve({ data: workspaceRows, error: null }) }),
            upsert: (incoming: Record<string, unknown>[]) => {
              workspaceUpserts.push(incoming);
              for (const r of incoming) {
                const idx = workspaceRows.findIndex((x) => x.workspace_id === r.workspace_id);
                if (idx >= 0) workspaceRows[idx] = { ...workspaceRows[idx], ...r };
                else workspaceRows.push({ ...r });
              }
              return Promise.resolve({ error: null });
            },
          };
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

  return { client, spendRows, syncRunUpdates, workspaceRows, workspaceUpserts };
}

const window = { startDate: "2026-07-01", endDate: "2026-08-01" };
const gareth = { id: "emp-1", email: "gareth.jones@intenthq.com" };
/** Workspace roster unavailable → the sync degrades to one org-wide query. */
const noWorkspaces = async () => {
  throw new Error("workspaces 503");
};

describe("syncOpenRouter", () => {
  it("writes attributed facts with tokens/requests and heals the activity remainder", async () => {
    const { client, spendRows } = fakeOpenRouterDb([], [gareth]);

    const result = await syncOpenRouter(client, window, async () => openRouterAnalyticsFixture, async () => openRouterActivityFixture, noWorkspaces);

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

    const result = await syncOpenRouter(client, window, async () => ({ data: { data: [] } }), async () => ({ data: [] }), noWorkspaces);

    expect(result.rowsWritten).toBe(0);
    expect(spendRows.some((r) => r.entity_key === "gareth.jones@intenthq.com")).toBe(true);
  });

  it("still succeeds when the activity cross-check fails — facts are analytics-only", async () => {
    const { client, spendRows } = fakeOpenRouterDb([], [gareth]);

    const result = await syncOpenRouter(client, window, async () => openRouterAnalyticsFixture, async () => {
      throw new Error("activity 503");
    }, noWorkspaces);

    expect(result.rowsWritten).toBeGreaterThan(0);
    expect(spendRows.some((r) => r.day === "2026-07-02" && r.entity_key === "unkeyed" && r.model === "")).toBe(false);
  });

  it("queries per workspace: member usage merges org-wide, keyless usage lands on the workspace's department", async () => {
    const { client, spendRows, workspaceRows, workspaceUpserts } = fakeOpenRouterDb(
      [],
      [gareth],
      // AI Operations is already registered with an admin-corrected mapping.
      [{ workspace_id: "ws-ops", name: "AI Operations", department: "AI Ops Team" }],
    );
    const row = (over: Record<string, unknown>) => ({
      date__day: "2026-07-01T00:00:00.000Z", user: "u1", user_email: "gareth.jones@intenthq.com",
      model: "anthropic/claude-sonnet-5", total_usage: 1, tokens_total: 10, request_count: 1, ...over,
    });
    const perWorkspace: Record<string, unknown[]> = {
      "ws-ops": [row({ total_usage: 2 }), row({ user: null, user_email: null, total_usage: 7 })],
      "ws-eng": [row({ total_usage: 3 })],
    };

    const result = await syncOpenRouter(
      client,
      window,
      async ({ workspaceId }) => ({ data: { data: perWorkspace[workspaceId ?? ""] ?? [] } }) as never,
      async () => ({ data: [] }),
      async () => [
        { id: "ws-ops", name: "AI Operations" },
        { id: "ws-eng", name: "Engineering" },
      ],
    );

    // Member usage summed across both workspaces, employee-attributed, no fact department.
    const member = spendRows.find((r) => r.entity_key === "gareth.jones@intenthq.com");
    expect(member).toMatchObject({ cost_usd: 5, employee_id: "emp-1", department: null });

    // Keyless usage lands on the workspace entity with its MAPPED department (not the name).
    const ws = spendRows.find((r) => r.entity_key === "AI Operations");
    expect(ws).toMatchObject({ cost_usd: 7, employee_id: null, department: "AI Ops Team" });
    expect(result.unmatched).not.toContain("AI Operations");

    // New workspace registered with department prefilled to its own name;
    // the known workspace's refresh payload omits department (mapping intact).
    expect(workspaceRows.find((w) => w.workspace_id === "ws-eng")).toMatchObject({ name: "Engineering", department: "Engineering" });
    expect(workspaceRows.find((w) => w.workspace_id === "ws-ops")?.department).toBe("AI Ops Team");
    for (const batch of workspaceUpserts) {
      for (const r of batch) {
        if (r.workspace_id === "ws-ops") expect(r).not.toHaveProperty("department");
      }
    }
  });

  it("marks the run failed and rethrows when the analytics fetch fails", async () => {
    const { client, syncRunUpdates } = fakeOpenRouterDb([], [gareth]);

    await expect(
      syncOpenRouter(client, window, async () => { throw new Error("analytics truncated"); }, async () => ({ data: [] }), noWorkspaces),
    ).rejects.toThrow("analytics truncated");
    expect(syncRunUpdates.at(-1)).toMatchObject({ status: "failed" });
  });
});
