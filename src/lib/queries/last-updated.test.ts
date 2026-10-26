import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getLastUpdated } from "./last-updated";

/** A fake covering exactly the LIMIT-1 chains getLastUpdated builds; records each query's filters. */
function fakeDb(rows: { sync_runs: Record<string, unknown>[]; imports: Record<string, unknown>[] }) {
  const queries: { table: string; filters: Record<string, unknown>; order: string }[] = [];
  const client = {
    from(table: "sync_runs" | "imports") {
      const q = { table, filters: {} as Record<string, unknown>, order: "" };
      queries.push(q);
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { q.filters[col] = val; return chain; },
        order: (col: string) => { q.order = col; return chain; },
        limit: async () => {
          const data = rows[table]
            .filter((r) => Object.entries(q.filters).every(([k, v]) => r[k] === v))
            .sort((a, b) => String(b[q.order]).localeCompare(String(a[q.order])))
            .slice(0, 1);
          return { data, error: null };
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

describe("getLastUpdated", () => {
  it("takes each automatic source's last SUCCESSFUL sync and each manual source's latest paste", async () => {
    const { client, queries } = fakeDb({
      sync_runs: [
        { source: "vercel", status: "success", finished_at: "2026-10-19T06:01:00+00:00" },
        { source: "vercel", status: "running", finished_at: null, started_at: "2026-10-26T06:00:48+00:00" },
        { source: "cursor", status: "failed", finished_at: "2026-10-26T06:01:00+00:00" },
        { source: "cursor", status: "success", finished_at: "2026-10-25T06:01:12+00:00" },
        { source: "recurring", status: "success", finished_at: "2026-10-26T06:00:52+00:00" },
      ],
      imports: [
        { source: "claude_team", data_as_of: "2026-10-12" },
        { source: "claude_team", data_as_of: "2026-10-19" },
        { source: "chatgpt_business", data_as_of: "2026-09-30" },
      ],
    });
    const out = await getLastUpdated(client);
    expect(out).toEqual({
      vercel: "2026-10-19",
      cursor: "2026-10-25",
      other: "2026-10-26",
      claude_team: "2026-10-19",
      chatgpt_business: "2026-09-30",
      anthropic: null,
      openai: null,
      openrouter: null,
    });
    // One bounded query per vendor, never a whole-table read (gotcha #1).
    expect(queries).toHaveLength(8);
    expect(queries.filter((q) => q.table === "sync_runs").every((q) => q.filters.status === "success")).toBe(true);
  });

  it("throws rather than report a vendor as never updated when the read fails", async () => {
    const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: async () => ({ data: null, error: { message: "boom" } }) };
    const client = { from: () => chain } as unknown as SupabaseClient;
    await expect(getLastUpdated(client)).rejects.toThrow(/boom/);
  });
});
