import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OktaGroupFetcher } from "@/lib/ingest/sources/okta";
import { syncClaudeSeats } from "./run-claude-seats";

/**
 * Stateful fake covering every table syncClaudeSeats touches, adapted from
 * fakeChatGptSeatsDb in run-chatgpt-seats.test.ts (itself modeled on
 * fakeSpendFactsDb in persist.test.ts) and extended with a seat_assignments
 * table (select→eq→order→range → empty rows, so resolveClaudeTiers falls back
 * to "standard" for everyone) since claude_seats also resolves tiers.
 */
function fakeClaudeSeatsDb(initialSpendFacts: Record<string, unknown>[]) {
  const rows: Record<string, unknown>[] = initialSpendFacts.map((r, i) => ({ id: `seed${i}`, ...r }));
  let nextId = 0;
  let runId = 0;

  const spendFactsTable = () => ({
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
        neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q; },
        gte: (c: string, v: string) => { filters.push((r) => (r[c] as string) >= v); return q; },
        lt: (c: string, v: string) => { filters.push((r) => (r[c] as string) < v); return q; },
        order: () => q,
        range: (from: number, to: number) =>
          Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }),
      };
      return q;
    },
    // Supports both the rebuild/replace `.in(ids)` bulk prune and the
    // zero-facts `.eq().eq().eq().eq()` surgical-remove-unassigned-fact path
    // (replaceSeatMonth) — the query builder itself is awaitable (thenable),
    // matching real supabase-js chains.
    delete: () => {
      const filters: ((r: Record<string, unknown>) => boolean)[] = [];
      const builder = {
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
        // Only supports the "prefix%" shape replaceSeatMonth's empty-path delete uses.
        like: (c: string, pattern: string) => {
          if (!pattern.endsWith("%")) throw new Error(`fake like: unsupported pattern "${pattern}"`);
          const prefix = pattern.slice(0, -1);
          filters.push((r) => (r[c] as string).startsWith(prefix));
          return builder;
        },
        in: (_c: string, ids: string[]) => {
          for (const id of ids) {
            const i = rows.findIndex((r) => r.id === id);
            if (i >= 0) rows.splice(i, 1);
          }
          return Promise.resolve({ error: null });
        },
        then: (resolve: (v: { error: null }) => void) => {
          for (let i = rows.length - 1; i >= 0; i--) {
            if (filters.every((f) => f(rows[i]))) rows.splice(i, 1);
          }
          resolve({ error: null });
        },
      };
      return builder;
    },
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
        case "employees":
          return { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }) };
        case "seat_assignments":
          // resolveClaudeTiers: select().eq().order().range() → no rows, every
          // member falls back to "standard".
          return {
            select: () => ({
              eq: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }),
            }),
          };
        case "seat_month_entries":
        case "seat_prices":
          return {
            // Generic chainable stub: getSeatMonthEntry (3× eq + limit) and
            // defaultSeatPrice (2× eq + lte + order + limit, or 2× eq + limit)
            // all resolve to "no rows" so the caller falls through the price chain.
            select: () => {
              const chain = {
                eq: () => chain,
                lte: () => chain,
                order: () => chain,
                limit: () => Promise.resolve({ data: [], error: null }),
              };
              return chain;
            },
          };
        case "spend_facts":
          return spendFactsTable();
        default:
          throw new Error(`fakeClaudeSeatsDb: unexpected table "${table}"`);
      }
    },
  } as unknown as SupabaseClient;

  return { client, rows };
}

describe("syncClaudeSeats — empty group can't wipe the month (gotcha #4)", () => {
  // Regression lock: this passes today (the behavior already exists via
  // replaceSeatMonth's zero-facts path, which only ever removes a leftover
  // "unassigned seats (standard/premium)" row, never a real member's seat
  // fact). Written to pin that guarantee so a future refactor of the
  // orchestrator can't silently reintroduce a window wipe when an Okta group
  // fetch returns [].
  it("leaves an existing member seat fact intact when the fetcher returns no members", async () => {
    const month = new Date().toISOString().slice(0, 7) + "-01";
    const { client, rows } = fakeClaudeSeatsDb([
      {
        source: "claude_team", day: month, cost_type: "seat",
        entity_key: "alex.morgan@intenthq.com", model: "", cost_usd: 19.05, employee_id: "e1",
      },
    ]);
    const emptyFetcher: OktaGroupFetcher = async () => [];

    const result = await syncClaudeSeats(client, emptyFetcher);

    expect(result.rowsWritten).toBe(0);
    const keys = rows.map((r) => `${r.source}|${r.cost_type}|${r.entity_key}`);
    expect(keys).toContain("claude_team|seat|alex.morgan@intenthq.com"); // survives
  });
});
