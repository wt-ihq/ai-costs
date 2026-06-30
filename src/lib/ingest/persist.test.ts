import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { attachEmployees, upsertSpendFacts, type ResolvedFact } from "./persist";
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
