import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeSeatFacts, replaceSeatMonth, UNASSIGNED_SEATS_KEY, pickTier } from "./seat-months";
import { computeClaudeSeatFacts, CLAUDE_UNASSIGNED_KEY, defaultSeatPrice, rebuildClaudeSeatMonth } from "./seat-months";

const MONTH = "2026-06-01";
const members = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ entityKey: `person ${i + 1}`, employeeId: i === 0 ? "e1" : null }));

const total = (facts: { costUsd: number }[]) =>
  Math.round(facts.reduce((s, f) => s + f.costUsd * 100, 0)); // cents, avoids float noise

describe("computeSeatFacts", () => {
  it("no entry: members at the default price (today's behavior), no unassigned fact", () => {
    const facts = computeSeatFacts(MONTH, null, members(3), 25);
    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.costUsd === 25 && f.costType === "seat" && f.day === MONTH)).toBe(true);
    expect(facts.find((f) => f.entityKey === UNASSIGNED_SEATS_KEY)).toBeUndefined();
    expect(facts[0].employeeId).toBe("e1"); // attribution preserved
  });

  it("entry with no members: one unassigned fact of seats × price", () => {
    const facts = computeSeatFacts(MONTH, { seats: 27, priceUsd: 25 }, [], 25);
    expect(facts).toEqual([
      expect.objectContaining({ entityKey: UNASSIGNED_SEATS_KEY, costUsd: 675, employeeId: null }),
    ]);
  });

  it("entry with fewer members than seats: members at price + unassigned remainder", () => {
    const facts = computeSeatFacts(MONTH, { seats: 23, priceUsd: 25 }, members(20), 99);
    expect(facts).toHaveLength(21);
    expect(facts.filter((f) => f.entityKey !== UNASSIGNED_SEATS_KEY).every((f) => f.costUsd === 25)).toBe(true);
    expect(facts.find((f) => f.entityKey === UNASSIGNED_SEATS_KEY)?.costUsd).toBe(75); // (23-20) × 25
    expect(total(facts)).toBe(57500); // exactly 23 × $25
  });

  it("entry with members == seats: no unassigned fact", () => {
    const facts = computeSeatFacts(MONTH, { seats: 3, priceUsd: 30 }, members(3), 25);
    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.costUsd === 30)).toBe(true);
  });

  it("entry with MORE members than seats: total split evenly, cent-exact", () => {
    // 20 seats × $25 = $500.00 over 23 members: 22 × $21.73 + 1 × $21.94
    const facts = computeSeatFacts(MONTH, { seats: 20, priceUsd: 25 }, members(23), 25);
    expect(facts).toHaveLength(23);
    expect(facts.find((f) => f.entityKey === UNASSIGNED_SEATS_KEY)).toBeUndefined();
    expect(total(facts)).toBe(50000); // exactly 20 × $25
    expect(facts.slice(0, 22).every((f) => f.costUsd === 21.73)).toBe(true);
    expect(facts[22].costUsd).toBe(21.94); // last row absorbs the rounding remainder
  });

  it("entry with MORE members than seats: remainder placement is deterministic by entityKey, not input order", () => {
    // 2 seats × $25 = $50.00 over 3 members: floor(5000/3)=1666 -> alpha/bravo 16.66, charlie (last alphabetically) 16.68.
    const memberSet = [
      { entityKey: "charlie", employeeId: null },
      { entityKey: "alpha", employeeId: null },
      { entityKey: "bravo", employeeId: null },
    ];
    const forward = computeSeatFacts(MONTH, { seats: 2, priceUsd: 25 }, memberSet, 25);
    const reversed = computeSeatFacts(MONTH, { seats: 2, priceUsd: 25 }, [...memberSet].reverse(), 25);

    const toMap = (facts: { entityKey: string; costUsd: number }[]) =>
      Object.fromEntries(facts.map((f) => [f.entityKey, f.costUsd]));

    expect(toMap(forward)).toEqual({ alpha: 16.66, bravo: 16.66, charlie: 16.68 });
    expect(toMap(reversed)).toEqual(toMap(forward));
  });

  it("entry priced per month overrides the default", () => {
    const facts = computeSeatFacts(MONTH, { seats: 2, priceUsd: 20 }, members(2), 25);
    expect(facts.every((f) => f.costUsd === 20)).toBe(true);
  });

  it("zero-total entry with no members yields no facts (caller removes any stale unassigned fact)", () => {
    expect(computeSeatFacts(MONTH, { seats: 0, priceUsd: 25 }, [], 25)).toEqual([]);
  });
});

describe("computeSeatFacts with source/unassignedKey opts", () => {
  it("stamps the given source and unassigned key", () => {
    const facts = computeSeatFacts(MONTH, { seats: 2, priceUsd: 19.05 }, [], 19.05, {
      source: "claude_team",
      unassignedKey: CLAUDE_UNASSIGNED_KEY.standard,
    });
    expect(facts).toEqual([
      expect.objectContaining({ source: "claude_team", entityKey: "unassigned seats (standard)", costUsd: 38.1 }),
    ]);
  });

  it("defaults remain ChatGPT (regression)", () => {
    const facts = computeSeatFacts(MONTH, { seats: 1, priceUsd: 25 }, [], 25);
    expect(facts[0]).toMatchObject({ source: "chatgpt_business", entityKey: "unassigned seats" });
  });
});

/**
 * Stateful in-memory spend_facts table modeled on fakeSpendFactsDb in
 * persist.test.ts, extended with a LIKE-aware delete chain — replaceSeatMonth's
 * empty-facts path deletes by entity_key prefix (`.like("entity_key", pattern)`)
 * so it can remove any of a source's unassigned-seat keys in one shot.
 */
function fakeSpendFactsDb(initial: Record<string, unknown>[]) {
  const rows: Record<string, unknown>[] = initial.map((r, i) => ({ id: `seed${i}`, ...r }));
  const client = {
    from: () => ({
      delete: () => {
        const filters: ((r: Record<string, unknown>) => boolean)[] = [];
        const builder = {
          eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
          like: (c: string, pattern: string) => {
            // Only the "prefix%" shape is used in production.
            if (!pattern.endsWith("%")) throw new Error(`fake like: unsupported pattern "${pattern}"`);
            const prefix = pattern.slice(0, -1);
            filters.push((r) => (r[c] as string).startsWith(prefix));
            return builder;
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
    }),
  } as unknown as SupabaseClient;
  return { client, rows };
}

describe("replaceSeatMonth — empty-facts path deletes by LIKE prefix", () => {
  const MONTH = "2026-06-01";

  it("removes a claude_team unassigned-tier fact while a member fact survives", async () => {
    const { client, rows } = fakeSpendFactsDb([
      {
        source: "claude_team", day: MONTH, cost_type: "seat",
        entity_key: "unassigned seats (standard)", model: "", cost_usd: 19.05, employee_id: null,
      },
      {
        source: "claude_team", day: MONTH, cost_type: "seat",
        entity_key: "a@intenthq.com", model: "", cost_usd: 19.05, employee_id: "e1",
      },
    ]);

    const written = await replaceSeatMonth(client, MONTH, [], "claude_team");

    expect(written).toBe(0);
    const keys = rows.map((r) => `${r.source}|${r.cost_type}|${r.entity_key}`);
    expect(keys).not.toContain("claude_team|seat|unassigned seats (standard)"); // removed
    expect(keys).toContain("claude_team|seat|a@intenthq.com"); // survives
  });
});

describe("computeClaudeSeatFacts", () => {
  const std = [{ entityKey: "a@x.com", employeeId: "e1" }, { entityKey: "b@x.com", employeeId: null }];
  const prem = [{ entityKey: "c@x.com", employeeId: "e3" }];

  it("computes per tier with distinct unassigned keys, cent-exact per tier", () => {
    const facts = computeClaudeSeatFacts(MONTH, [
      { seatType: "standard", entry: { seats: 3, priceUsd: 19.05 }, members: std, defaultPriceUsd: 19.05 },
      { seatType: "premium", entry: { seats: 2, priceUsd: 95.25 }, members: prem, defaultPriceUsd: 95.25 },
    ]);
    // standard: 2 members at 19.05 + remainder (3-2)×19.05; premium: 1 member + 1 unassigned
    expect(facts.filter((f) => f.source === "claude_team")).toHaveLength(facts.length);
    expect(facts.find((f) => f.entityKey === CLAUDE_UNASSIGNED_KEY.standard)?.costUsd).toBe(19.05);
    expect(facts.find((f) => f.entityKey === CLAUDE_UNASSIGNED_KEY.premium)?.costUsd).toBe(95.25);
    const total = Math.round(facts.reduce((s, f) => s + f.costUsd * 100, 0));
    expect(total).toBe(Math.round((3 * 19.05 + 2 * 95.25) * 100)); // 5715 + 19050
  });

  it("no entries: each tier's members at that tier's default price", () => {
    const facts = computeClaudeSeatFacts(MONTH, [
      { seatType: "standard", entry: null, members: std, defaultPriceUsd: 19.05 },
      { seatType: "premium", entry: null, members: prem, defaultPriceUsd: 95.25 },
    ]);
    expect(facts.find((f) => f.entityKey === "a@x.com")?.costUsd).toBe(19.05);
    expect(facts.find((f) => f.entityKey === "c@x.com")?.costUsd).toBe(95.25);
    expect(facts.filter((f) => f.entityKey.startsWith("unassigned seats"))).toHaveLength(0);
  });

  it("returns [] only when every tier yields [] (zero totals, no members)", () => {
    expect(computeClaudeSeatFacts(MONTH, [
      { seatType: "standard", entry: { seats: 0, priceUsd: 19.05 }, members: [], defaultPriceUsd: 19.05 },
      { seatType: "premium", entry: null, members: [], defaultPriceUsd: 95.25 },
    ])).toEqual([]);
  });
});

describe("pickTier", () => {
  const a = (seatType: string, periodStart: string) => ({ seatType, periodStart });
  it("picks the assignment with the greatest period_start ≤ the month", () => {
    expect(pickTier([a("standard", "2026-01-01"), a("premium", "2026-04-01"), a("standard", "2026-08-01")], "2026-06-01")).toBe("premium");
  });
  it("falls back to the latest assignment when all are after the month", () => {
    expect(pickTier([a("premium", "2026-08-01"), a("standard", "2026-09-01")], "2026-06-01")).toBe("standard");
  });
  it("defaults to standard with no assignments or unknown tier strings", () => {
    expect(pickTier([], "2026-06-01")).toBe("standard");
    expect(pickTier([a("unassigned", "2026-01-01")], "2026-06-01")).toBe("standard");
  });
});

/**
 * Fake covering only the tables defaultSeatPrice touches: seat_month_entries
 * (eq × 2, optional lte, order, limit) and seat_prices (eq × 2, limit). The
 * `.order()` call is a no-op passthrough — the terminal `.limit()` does the
 * real filtering (and, for entries, a month-desc sort so "latest ≤ month"
 * behaves correctly regardless of seed order).
 */
function fakeSeatPricingDb(
  entries: { vendor: string; seat_type: string; month: string; price_usd: number }[],
  seatPrices: { vendor: string; seat_type: string; monthly_price_usd: number }[] = [],
) {
  type Row = Record<string, unknown>;
  const client = {
    from: (table: string) => {
      if (table === "seat_month_entries") {
        return {
          select: () => {
            const filters: ((r: Row) => boolean)[] = [];
            const chain = {
              eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
              lte: (c: string, v: string) => { filters.push((r) => (r[c] as string) <= v); return chain; },
              order: () => chain,
              limit: (n: number) => {
                const matched = (entries as Row[])
                  .filter((r) => filters.every((f) => f(r)))
                  .sort((a, b) => (b.month as string).localeCompare(a.month as string));
                return Promise.resolve({ data: matched.slice(0, n), error: null });
              },
            };
            return chain;
          },
        };
      }
      if (table === "seat_prices") {
        return {
          select: () => {
            const filters: ((r: Row) => boolean)[] = [];
            const chain = {
              eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
              limit: (n: number) =>
                Promise.resolve({ data: (seatPrices as Row[]).filter((r) => filters.every((f) => f(r))).slice(0, n), error: null }),
            };
            return chain;
          },
        };
      }
      throw new Error(`fakeSeatPricingDb: unexpected table "${table}"`);
    },
  } as unknown as SupabaseClient;
  return client;
}

describe("defaultSeatPrice — price as-of the month, not the global latest", () => {
  // Two entries for claude_team:standard: 2026-01-01 → $15, 2026-03-01 → $30.
  const entries = [
    { vendor: "claude_team", seat_type: "standard", month: "2026-01-01", price_usd: 15 },
    { vendor: "claude_team", seat_type: "standard", month: "2026-03-01", price_usd: 30 },
  ];

  it("pricing a month between the two entries uses the latest entry AT OR BEFORE it (Feb -> Jan's $15)", async () => {
    const client = fakeSeatPricingDb(entries);
    const price = await defaultSeatPrice(client, "claude_team", "standard", "2026-02-01");
    // Regression check: global-latest (pre-fix) behavior would return 30 here.
    expect(price).toBe(15);
  });

  it("pricing a month at/after the later entry uses it (Apr -> Mar's $30)", async () => {
    const client = fakeSeatPricingDb(entries);
    const price = await defaultSeatPrice(client, "claude_team", "standard", "2026-04-01");
    expect(price).toBe(30);
  });

  it("pricing a month before any entry falls through to seat_prices, then the constant fallback", async () => {
    const client = fakeSeatPricingDb(entries); // no seat_prices rows seeded
    const price = await defaultSeatPrice(client, "claude_team", "standard", "2025-12-01");
    expect(price).toBe(19.05); // SEAT_PRICE_FALLBACK["claude_team:standard"]
  });
});

/**
 * Fake covering every table rebuildClaudeSeatMonth touches directly (no
 * sync_runs/raw_payloads/employees — the orchestrator layer isn't exercised
 * here): spend_facts (member facts in, rebuilt facts out via replaceWindowFacts),
 * seat_assignments (tier resolution), seat_month_entries + seat_prices (pricing).
 */
function fakeClaudeRebuildDb(opts: {
  spendFacts: Record<string, unknown>[];
  seatAssignments: Record<string, unknown>[];
  seatMonthEntries: Record<string, unknown>[];
  seatPrices?: Record<string, unknown>[];
}) {
  type Row = Record<string, unknown>;
  const rows: Row[] = opts.spendFacts.map((r, i) => ({ id: `seed${i}`, ...r }));
  let nextId = 0;

  const spendFactsTable = () => ({
    upsert: (incoming: Row[]) => {
      for (const r of incoming) {
        const key = (x: Row) => `${x.source}|${x.day}|${x.cost_type}|${x.entity_key}|${x.model}`;
        const idx = rows.findIndex((x) => key(x) === key(r));
        if (idx >= 0) rows[idx] = { ...rows[idx], ...r };
        else rows.push({ id: `new${nextId++}`, ...r });
      }
      return Promise.resolve({ error: null });
    },
    select: () => {
      const filters: ((r: Row) => boolean)[] = [];
      const q = {
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q; },
        gte: (c: string, v: string) => { filters.push((r) => (r[c] as string) >= v); return q; },
        lt: (c: string, v: string) => { filters.push((r) => (r[c] as string) < v); return q; },
        not: (c: string, _op: string, pattern: string) => {
          const prefix = pattern.replace(/%$/, "");
          filters.push((r) => !(r[c] as string).startsWith(prefix));
          return q;
        },
        order: () => q,
        range: (from: number, to: number) =>
          Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }),
      };
      return q;
    },
    delete: () => {
      const filters: ((r: Row) => boolean)[] = [];
      const builder = {
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
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
        case "spend_facts":
          return spendFactsTable();
        case "seat_assignments":
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  range: (from: number, to: number) =>
                    Promise.resolve({ data: opts.seatAssignments.slice(from, to + 1), error: null }),
                }),
              }),
            }),
          };
        case "seat_month_entries":
          return {
            select: () => {
              const filters: ((r: Row) => boolean)[] = [];
              const chain = {
                eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
                lte: (c: string, v: string) => { filters.push((r) => (r[c] as string) <= v); return chain; },
                order: () => chain,
                limit: (n: number) => {
                  const matched = (opts.seatMonthEntries as Row[])
                    .filter((r) => filters.every((f) => f(r)))
                    .sort((a, b) => (b.month as string).localeCompare(a.month as string));
                  return Promise.resolve({ data: matched.slice(0, n), error: null });
                },
              };
              return chain;
            },
          };
        case "seat_prices":
          return {
            select: () => {
              const filters: ((r: Row) => boolean)[] = [];
              const chain = {
                eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
                limit: (n: number) =>
                  Promise.resolve({
                    data: (opts.seatPrices ?? []).filter((r) => filters.every((f) => f(r))).slice(0, n),
                    error: null,
                  }),
              };
              return chain;
            },
          };
        default:
          throw new Error(`fakeClaudeRebuildDb: unexpected table "${table}"`);
      }
    },
  } as unknown as SupabaseClient;

  return { client, rows };
}

describe("rebuildClaudeSeatMonth — direct regression lock", () => {
  // Regression lock (should pass immediately, no implementation change
  // required): pins the full tier-resolution + as-of-pricing + authoritative-
  // entry chain together for a Claude month, independent of the orchestrator
  // (syncClaudeSeats) tests in run-claude-seats.test.ts.
  const MONTH = "2026-06-01";

  it("prices e1 (standard) via the authoritative entry, e2 (premium) via the as-of fallback chain, plus an unassigned-standard fact", async () => {
    const { client, rows } = fakeClaudeRebuildDb({
      spendFacts: [
        {
          source: "claude_team", day: MONTH, cost_type: "seat",
          entity_key: "x@intenthq.com", model: "", cost_usd: 0, employee_id: "e1",
        },
        {
          source: "claude_team", day: MONTH, cost_type: "seat",
          entity_key: "y@intenthq.com", model: "", cost_usd: 0, employee_id: "e2",
        },
      ],
      seatAssignments: [
        { employee_id: "e2", vendor: "claude_team", seat_type: "premium", period_start: "2026-01-01" },
      ],
      seatMonthEntries: [
        { vendor: "claude_team", seat_type: "standard", month: MONTH, seats: 2, price_usd: 19.05 },
        // No premium entry at any month.
      ],
      seatPrices: [], // no seat_prices rows either
    });

    const written = await rebuildClaudeSeatMonth(client, MONTH);
    expect(written).toBeGreaterThan(0);

    const byKey = Object.fromEntries(
      rows.filter((r) => r.source === "claude_team" && r.cost_type === "seat").map((r) => [r.entity_key, r]),
    );

    expect((byKey["x@intenthq.com"] as { cost_usd: number }).cost_usd).toBe(19.05); // standard, entry-priced
    expect((byKey["y@intenthq.com"] as { cost_usd: number }).cost_usd).toBe(95.25); // premium, constant fallback
    expect((byKey["unassigned seats (standard)"] as { cost_usd: number }).cost_usd).toBe(19.05); // entry authoritative: 2 seats, 1 member -> 1 seat unassigned
    expect(byKey["unassigned seats (premium)"]).toBeUndefined(); // no premium entry -> no unassigned fact
  });
});
