import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeRecurringFacts, monthsBetween, pickColorSlot, rebuildRecurringFacts, type RecurringEntry } from "./recurring";

const THROUGH = "2026-07-01";
const entry = (over: Partial<RecurringEntry>): RecurringEntry => ({
  tool: "Perplexity", department: "Data Science", kind: "monthly",
  amount: 40, fxRate: 1, startMonth: "2026-05-01", endMonth: null, ...over,
});
const totalCents = (facts: { costUsd: number }[]) => Math.round(facts.reduce((s, f) => s + f.costUsd * 100, 0));

describe("monthsBetween", () => {
  it("is inclusive and rolls years", () => {
    expect(monthsBetween("2026-11-01", "2027-02-01")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
  });
});

describe("computeRecurringFacts", () => {
  it("monthly: one seat fact per month from start through the current month", () => {
    const facts = computeRecurringFacts([entry({})], THROUGH);
    expect(facts.map((f) => f.day)).toEqual(["2026-05-01", "2026-06-01", "2026-07-01"]);
    expect(facts[0]).toMatchObject({
      source: "other", costType: "subscription", costUsd: 40,
      entityKey: "perplexity|Data Science", model: "Perplexity",
      department: "Data Science", employeeId: null,
    });
  });

  it("monthly: clips at end_month; £ converts once", () => {
    const facts = computeRecurringFacts([entry({ amount: 40, fxRate: 1.27, endMonth: "2026-06-01" })], THROUGH);
    expect(facts.map((f) => f.day)).toEqual(["2026-05-01", "2026-06-01"]);
    expect(facts[0].costUsd).toBe(50.8); // round(40 × 1.27, 2)
  });

  it("contract: cent-exact even split, last month absorbs the remainder", () => {
    // €1000 at 1.17 = $1170.00 across 7 months: 6 × $167.14 + $167.16
    const facts = computeRecurringFacts(
      [entry({ kind: "contract", amount: 1000, fxRate: 1.17, startMonth: "2026-01-01", endMonth: "2026-07-01" })],
      THROUGH,
    );
    expect(facts).toHaveLength(7);
    expect(facts.slice(0, 6).every((f) => f.costUsd === 167.14)).toBe(true);
    expect(facts[6].costUsd).toBe(167.16);
    expect(totalCents(facts)).toBe(117000);
  });

  it("contract: future months beyond throughMonth are not materialized yet (remainder month included only when reached)", () => {
    const facts = computeRecurringFacts(
      [entry({ kind: "contract", amount: 1200, fxRate: 1, startMonth: "2026-06-01", endMonth: "2027-05-01" })],
      THROUGH,
    );
    expect(facts.map((f) => f.day)).toEqual(["2026-06-01", "2026-07-01"]); // 2 of 12 months so far
    expect(facts.every((f) => f.costUsd === 100)).toBe(true);
  });

  it("aggregates multiple entries for one (tool, month, department) into one fact", () => {
    const facts = computeRecurringFacts(
      [entry({ amount: 40 }), entry({ amount: 10, startMonth: "2026-07-01" })],
      THROUGH,
    );
    const july = facts.find((f) => f.day === "2026-07-01");
    expect(july?.costUsd).toBe(50);
    expect(facts.filter((f) => f.day === "2026-07-01")).toHaveLength(1);
  });

  it("keeps distinct departments as distinct facts (collision-free keys)", () => {
    const facts = computeRecurringFacts(
      [entry({ startMonth: "2026-07-01" }), entry({ startMonth: "2026-07-01", department: null })],
      THROUGH,
    );
    expect(facts.map((f) => f.entityKey).sort()).toEqual(["perplexity", "perplexity|Data Science"]);
    expect(facts.find((f) => f.entityKey === "perplexity")?.department).toBeNull();
  });

  it("ignores entries starting after throughMonth", () => {
    expect(computeRecurringFacts([entry({ startMonth: "2026-08-01" })], THROUGH)).toEqual([]);
  });
});

describe("pickColorSlot", () => {
  const t = (tool: string, colorSlot: number) => ({ tool, colorSlot });
  it("reuses the existing slot for a known tool (case-insensitive)", () => {
    expect(pickColorSlot([t("Perplexity", 3)], "perplexity")).toBe(3);
  });
  it("assigns the lowest free slot to a new tool", () => {
    expect(pickColorSlot([t("A", 0), t("B", 2)], "C")).toBe(1);
  });
  it("reuses the least-used slot when all 8 are taken", () => {
    const existing = [0, 1, 2, 3, 4, 5, 6, 7, 0].map((s, i) => t(`T${i}`, s)); // slot 0 used twice
    expect(pickColorSlot(existing, "New")).toBe(1); // lowest among the least-used (1..7 used once)
  });
});

/**
 * Stateful in-memory fake supporting the exact call chains rebuildRecurringFacts
 * makes: a `recurring_costs` select→order→range read, and — depending on
 * whether computeRecurringFacts produced any facts — either a `spend_facts`
 * delete().eq() full clear or the upsert/select/delete chains replaceWindowFacts
 * uses (modeled on fakeSpendFactsDb in persist.test.ts).
 */
function fakeRecurringDb(recurringRows: Record<string, unknown>[], initialFacts: Record<string, unknown>[] = []) {
  const facts: Record<string, unknown>[] = initialFacts.map((r, i) => ({ id: `seed${i}`, ...r }));
  let nextId = 0;
  const client = {
    from: (table: string) => {
      if (table === "recurring_costs") {
        return {
          select: () => ({
            order: () => ({
              range: (from: number, to: number) =>
                Promise.resolve({ data: recurringRows.slice(from, to + 1), error: null }),
            }),
          }),
        };
      }
      // spend_facts
      return {
        upsert: (incoming: Record<string, unknown>[]) => {
          for (const r of incoming) {
            const key = (x: Record<string, unknown>) => `${x.source}|${x.day}|${x.cost_type}|${x.entity_key}|${x.model}`;
            const idx = facts.findIndex((x) => key(x) === key(r));
            if (idx >= 0) facts[idx] = { ...facts[idx], ...r };
            else facts.push({ id: `new${nextId++}`, ...r });
          }
          return Promise.resolve({ error: null });
        },
        select: () => {
          const filters: ((r: Record<string, unknown>) => boolean)[] = [];
          let orderCol: string | null = null;
          const q = {
            eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
            gte: (c: string, v: string) => { filters.push((r) => (r[c] as string) >= v); return q; },
            lt: (c: string, v: string) => { filters.push((r) => (r[c] as string) < v); return q; },
            order: (c: string) => { orderCol = c; return q; },
            range: (from: number, to: number) =>
              Promise.resolve({ data: facts.filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }),
            // `.order("day").limit(1)` — earliest-existing-day lookup in
            // rebuildRecurringFacts. Sorts (ascending, by the ordered column)
            // since callers rely on getting the true minimum, not insertion order.
            limit: (n: number) => {
              const matched = facts.filter((r) => filters.every((f) => f(r)));
              if (orderCol) matched.sort((a, b) => ((a[orderCol!] as string) < (b[orderCol!] as string) ? -1 : 1));
              return Promise.resolve({ data: matched.slice(0, n), error: null });
            },
          };
          return q;
        },
        delete: () => ({
          // Zero-entries full clear: `.delete().eq("source", "other")` runs
          // (and resolves) directly, no further chaining.
          eq: (c: string, v: unknown) => {
            for (let i = facts.length - 1; i >= 0; i--) {
              if (facts[i][c] === v) facts.splice(i, 1);
            }
            return Promise.resolve({ error: null });
          },
          // replaceWindowFacts prune: `.delete().in("id", staleIds)`.
          in: (_c: string, ids: string[]) => {
            for (const id of ids) {
              const i = facts.findIndex((r) => r.id === id);
              if (i >= 0) facts.splice(i, 1);
            }
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  } as unknown as SupabaseClient;
  return { client, facts };
}

describe("rebuildRecurringFacts", () => {
  it("clears all source='other' facts when there are zero recurring entries", async () => {
    const { client, facts } = fakeRecurringDb([], [
      { source: "other", day: "2026-06-01", cost_type: "seat", entity_key: "perplexity|Data Science", model: "Perplexity", cost_usd: 40 },
    ]);

    const written = await rebuildRecurringFacts(client);

    expect(written).toBe(0);
    expect(facts).toHaveLength(0);
  });

  it("materializes facts from a monthly recurring entry", async () => {
    const { client, facts } = fakeRecurringDb([
      {
        id: "r1", tool: "Perplexity", color_slot: 0, department: "Data Science", kind: "monthly",
        amount: 40, currency: "USD", fx_rate: 1, start_month: "2026-01-01", end_month: null,
      },
    ]);

    const written = await rebuildRecurringFacts(client);

    expect(written).toBeGreaterThan(0);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.source === "other")).toBe(true);
  });

  it("prunes previously-materialized months that fall before the entry's new (forward-shifted) start", async () => {
    // Simulates a January-start entry whose start_month was later edited to
    // March: Jan/Feb facts were materialized under the old range and must be
    // pruned even though the recomputed window now starts in March.
    const { client, facts } = fakeRecurringDb(
      [
        {
          id: "r1", tool: "Perplexity", color_slot: 0, department: null, kind: "monthly",
          amount: 40, currency: "USD", fx_rate: 1, start_month: "2026-03-01", end_month: null,
        },
      ],
      [
        { source: "other", day: "2026-01-01", cost_type: "seat", entity_key: "perplexity", model: "Perplexity", cost_usd: 40 },
        { source: "other", day: "2026-02-01", cost_type: "seat", entity_key: "perplexity", model: "Perplexity", cost_usd: 40 },
        { source: "other", day: "2026-03-01", cost_type: "seat", entity_key: "perplexity", model: "Perplexity", cost_usd: 40 },
      ],
    );

    await rebuildRecurringFacts(client);

    const days = facts.filter((f) => f.entity_key === "perplexity").map((f) => f.day).sort();
    expect(days).not.toContain("2026-01-01");
    expect(days).not.toContain("2026-02-01");
    expect(days).toContain("2026-03-01");
  });
});
