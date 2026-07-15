import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchFactsInRange } from "./common";

/**
 * Stateful fake covering exactly the chains fetchFactsInRange uses:
 * select(cols, { count }) → gte → lt → [or|in|is] → order → order → range.
 * Regression lock for the count-then-parallel-pages pagination — every row
 * must come back exactly once, in (day, id) order, regardless of page count.
 */
function fakeFactsDb(rowCount: number) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    day: `2026-0${(i % 6) + 1}-01`,
    source: "cursor",
    cost_type: "seat",
    cost_usd: 1,
    requests: null,
    entity_key: `user${i}@x.com`,
    model: "",
    employee_id: null,
    department: null,
    employees: null,
    _id: i, // stand-in for the unique id tiebreaker
  })).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a._id - b._id));

  let requests = 0;
  const client = {
    from: () => ({
      select: (_cols: string, opts?: { count?: string }) => {
        const q = {
          gte: () => q,
          lt: () => q,
          or: () => q,
          in: () => q,
          is: () => q,
          order: () => q,
          range: (from: number, to: number) => {
            requests += 1;
            return Promise.resolve({
              data: rows.slice(from, to + 1),
              count: opts?.count ? rows.length : null,
              error: null,
            });
          },
        };
        return q;
      },
    }),
  } as unknown as SupabaseClient;
  return { client, requestCount: () => requests };
}

describe("fetchFactsInRange parallel pagination", () => {
  it("returns every row exactly once, in order, across multiple pages", async () => {
    const { client, requestCount } = fakeFactsDb(2500);
    const facts = await fetchFactsInRange(client, "2026-01-01", "2026-07-01");
    expect(facts).toHaveLength(2500);
    expect(new Set(facts.map((f) => f.entityKey)).size).toBe(2500); // no duplicates
    // Order preserved: days ascending as the fake sorted them.
    for (let i = 1; i < facts.length; i++) expect(facts[i].day >= facts[i - 1].day).toBe(true);
    expect(requestCount()).toBe(3); // 2500 rows = 1 counted page + 2 parallel pages
  });

  it("single short page needs exactly one request", async () => {
    const { client, requestCount } = fakeFactsDb(42);
    const facts = await fetchFactsInRange(client, "2026-01-01", "2026-07-01");
    expect(facts).toHaveLength(42);
    expect(requestCount()).toBe(1);
  });

  it("exact page-boundary total does not over-fetch", async () => {
    const { client, requestCount } = fakeFactsDb(2000);
    const facts = await fetchFactsInRange(client, "2026-01-01", "2026-07-01");
    expect(facts).toHaveLength(2000);
    expect(requestCount()).toBe(2);
  });
});
