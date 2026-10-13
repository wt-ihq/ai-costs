import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ingest/sources/anthropic", () => ({
  fetchAnthropicCost: async () => ({ data: [{ starting_at: "2026-10-05T00:00:00Z", results: [{ amount: "1000" }] }] }),
  fetchAnthropicUsage: async () => ({
    data: [{ starting_at: "2026-10-05T00:00:00Z", results: [{ api_key_id: "key_gone", model: "claude-sonnet-4-5", uncached_input_tokens: 1000000, output_tokens: 0 }] }],
  }),
  fetchAnthropicApiKeys: async () => ({ data: [{ id: "key_gone", name: "Gone", created_by: { id: "u_gone" } }] }),
  fetchAnthropicUsers: async () => ({ data: [] }),
}));

import { syncAnthropic, syncOpenAI } from "@/lib/ingest/run-platforms";

const FORMER = "emp-former-user";

/** Minimal fake: reads return `tables`, upserts are recorded per table. */
function fakeSupabase(tables: Record<string, unknown[]>) {
  const upserts: Record<string, Record<string, unknown>[]> = {};
  const q = (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b, order: () => b, eq: () => b, gte: () => b, lt: () => b, in: () => b, is: () => b,
      range: async () => ({ data: tables[table] ?? [], error: null }),
      single: async () => ({ data: { id: "run1" }, error: null }),
      insert: () => b, update: () => b, delete: () => b,
      upsert: async (rows: Record<string, unknown>[]) => {
        (upserts[table] ??= []).push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      },
      then: (r: (v: unknown) => unknown) => r({ data: [], error: null }),
    };
    return b;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from: q } as any, upserts };
}

describe("owner overrides in the syncs", () => {
  it("anthropic sync honours api_keys.owner_override and never writes it", async () => {
    const { client, upserts } = fakeSupabase({
      employees: [{ id: FORMER, email: "gone@intenthq.com" }],
      api_keys: [{ id: "k1", external_key_id: "key_gone", owner_employee_id: null, owner_override: FORMER }],
    });
    await syncAnthropic(client, { startDate: "2026-10-01", endDate: "2026-10-14" });
    const facts = upserts.spend_facts as { entity_key: string; employee_id: string | null }[];
    expect(facts.find((f) => f.entity_key === "key_gone")?.employee_id).toBe(FORMER);
    for (const r of upserts.api_keys ?? []) expect(r).not.toHaveProperty("owner_override");
  });

  it("openai sync honours projects.owner_override", async () => {
    const { client, upserts } = fakeSupabase({
      projects: [{ id: "p1", external_id: "proj_x", owner_employee_id: null, owner_override: FORMER }],
    });
    const fetcher = async () => ({
      data: [{ start_time_iso: "2026-10-05T00:00:00Z", results: [{ amount: { value: "5" }, project_id: "proj_x" }] }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await syncOpenAI(client, { startDate: "2026-10-01", endDate: "2026-10-14" }, fetcher as any);
    const facts = upserts.spend_facts as { entity_key: string; employee_id: string | null }[];
    expect(facts.find((f) => f.entity_key === "proj_x")?.employee_id).toBe(FORMER);
  });
});
