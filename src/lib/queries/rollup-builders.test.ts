import { describe, expect, it } from "vitest";
import { buildDepartmentRows } from "./departments";
import { buildPeopleRows } from "./people";
import type { EnrichedFact } from "./common";

const facts: EnrichedFact[] = [
  { source: "claude_team", costType: "seat", costUsd: 30, requests: null, employeeId: "a", fullName: "Alice A", department: "Engineering" },
  { source: "cursor", costType: "metered", costUsd: 18.75, requests: 42, employeeId: "a", fullName: "Alice A", department: "Engineering" },
  { source: "claude_team", costType: "seat", costUsd: 30, requests: null, employeeId: "b", fullName: "Bob B", department: "Engineering" },
  { source: "claude_team", costType: "overage", costUsd: 246.78, requests: null, employeeId: "c", fullName: "Carol C", department: "Product" },
  { source: "cursor", costType: "metered", costUsd: 0.9, requests: 3, employeeId: null, fullName: null, department: null },
];

describe("buildDepartmentRows", () => {
  it("builds the dept×vendor matrix with per-head spend", () => {
    const { vendors, rows } = buildDepartmentRows(
      facts,
      new Map([["Engineering", 2], ["Product", 1]]),
    );
    expect(vendors).toEqual(["claude_team", "cursor"]);

    const eng = rows.find((r) => r.department === "Engineering")!;
    expect(eng.total).toBeCloseTo(78.75);
    expect(eng.perVendor.claude_team).toBe(60);
    expect(eng.perHead).toBeCloseTo(39.375); // 78.75 / 2 headcount
  });

  it("leaves per-head null for the Unattributed bucket", () => {
    const { rows } = buildDepartmentRows(facts, new Map());
    const un = rows.find((r) => r.department === "Unattributed")!;
    expect(un.total).toBeCloseTo(0.9);
    expect(un.perHead).toBeNull();
  });
});

describe("buildPeopleRows", () => {
  it("collapses to one row per employee and flags zero-activity seats", () => {
    const rows = buildPeopleRows(facts);
    expect(rows).toHaveLength(3); // unmatched fact excluded

    const alice = rows.find((r) => r.employeeId === "a")!;
    expect(alice.seatCost).toBe(30);
    expect(alice.metered).toBe(18.75);
    expect(alice.zeroActivity).toBe(false);

    const bob = rows.find((r) => r.employeeId === "b")!;
    expect(bob.seatCost).toBe(30);
    expect(bob.activityUsd).toBe(0);
    expect(bob.zeroActivity).toBe(true); // paying for a seat, no usage
  });
});
