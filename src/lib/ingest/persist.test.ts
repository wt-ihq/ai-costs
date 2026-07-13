import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { attachEmployees, upsertSpendFacts, replaceWindowFacts, type ResolvedFact } from "./persist";
import { normalizeCursor } from "./normalizers/cursor";
import { cursorUsageFixture } from "./fixtures/cursor-usage";

const employees = [
  { id: "g", email: "gareth.jones@intenthq.com" },
  { id: "t", email: "tom.reeve@intenthq.com" },
];

describe("attachEmployees", () => {
  it("attaches employee_id by email and collects unmatched keys", () => {
    const facts = normalizeCursor(cursorUsageFixture);
    const { facts: resolved, unmatched } = attachEmployees(facts, employees);

    expect(resolved.find((f) => f.entityKey === "gareth.jones@intenthq.com")?.employeeId).toBe("g");
    expect(resolved.find((f) => f.entityKey === "tom.reeve@intenthq.com")?.employeeId).toBe("t");
    expect(resolved.find((f) => f.entityKey === "contractor@external.dev")?.employeeId).toBeNull();
    expect(unmatched).toEqual(["contractor@external.dev"]);
  });
});

describe("upsertSpendFacts", () => {
  it("collapses duplicate conflict keys so ON CONFLICT can't hit a row twice", async () => {
    let sent: Record<string, unknown>[] = [];
    const fake = {
      from: () => ({
        upsert: (rows: Record<string, unknown>[]) => {
          sent = rows;
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;

    // Same (cursor, 2026-06-01, seat, email, '') from an active-user seat AND a
    // member seat — must collapse to one row before the upsert.
    const seat = (employeeId: string | null): ResolvedFact => ({
      source: "cursor", day: "2026-06-01", costType: "seat", entityKey: "gareth.jones@intenthq.com", costUsd: 40, employeeId,
    });
    const written = await upsertSpendFacts(fake, [seat("g"), seat("g")]);

    expect(written).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

/** Stateful in-memory spend_facts table supporting the exact call chains replaceWindowFacts makes. */
function fakeSpendFactsDb(initial: Record<string, unknown>[]) {
  const rows: Record<string, unknown>[] = initial.map((r, i) => ({ id: `seed${i}`, ...r }));
  let nextId = 0;
  const client = {
    from: () => ({
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
          gte: (c: string, v: string) => { filters.push((r) => (r[c] as string) >= v); return q; },
          lt: (c: string, v: string) => { filters.push((r) => (r[c] as string) < v); return q; },
          order: () => q,
          range: (from: number, to: number) =>
            Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }),
        };
        return q;
      },
      delete: () => ({
        in: (_c: string, ids: string[]) => {
          for (const id of ids) {
            const i = rows.findIndex((r) => r.id === id);
            if (i >= 0) rows.splice(i, 1);
          }
          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { client, rows };
}

describe("replaceWindowFacts with a cost-type scope", () => {
  it("prunes stale rows only within the scoped cost type — seat facts survive an overage replace", async () => {
    const { client, rows } = fakeSpendFactsDb([
      // paste-era seat fact — must survive
      { source: "chatgpt_business", day: "2026-05-01", cost_type: "seat", entity_key: "omar ali", model: "", cost_usd: 25 },
      // paste-era month-stamped overage — must be pruned (not in the new snapshot)
      { source: "chatgpt_business", day: "2026-05-01", cost_type: "overage", entity_key: "omar ali", model: "", cost_usd: 360 },
      // other source in-window — must survive
      { source: "claude_team", day: "2026-05-10", cost_type: "overage", entity_key: "x@intenthq.com", model: "", cost_usd: 9 },
    ]);

    const written = await replaceWindowFacts(
      client,
      "chatgpt_business",
      { startDate: "2026-05-01", endDate: "2026-06-01" },
      [{
        source: "chatgpt_business", day: "2026-05-02", costType: "overage",
        entityKey: "omar.ali@intenthq.com", costUsd: 7.03, model: "GPT-5.5 Codex (fast)", employeeId: "e1",
      }],
      { costType: "overage" },
    );

    expect(written).toBe(1);
    const keys = rows.map((r) => `${r.source}|${r.cost_type}|${r.entity_key}`);
    expect(keys).toContain("chatgpt_business|seat|omar ali");                 // survived
    expect(keys).toContain("claude_team|overage|x@intenthq.com");             // survived
    expect(keys).toContain("chatgpt_business|overage|omar.ali@intenthq.com"); // new fact
    expect(keys).not.toContain("chatgpt_business|overage|omar ali");          // pruned
  });
});
