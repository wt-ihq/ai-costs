import { describe, expect, it } from "vitest";
import { buildDepartmentRows } from "./departments";
import { buildPeopleRows } from "./people";
import type { EnrichedFact } from "./common";

const facts: EnrichedFact[] = [
  { day: "2024-01-15", source: "claude_team", costType: "seat", costUsd: 30, requests: null, entityKey: "", model: "", employeeId: "a", fullName: "Alice A", department: "Engineering" },
  { day: "2024-01-15", source: "cursor", costType: "metered", costUsd: 18.75, requests: 42, entityKey: "", model: "", employeeId: "a", fullName: "Alice A", department: "Engineering" },
  { day: "2024-01-15", source: "claude_team", costType: "seat", costUsd: 30, requests: null, entityKey: "", model: "", employeeId: "b", fullName: "Bob B", department: "Engineering" },
  { day: "2024-01-15", source: "claude_team", costType: "overage", costUsd: 246.78, requests: null, entityKey: "", model: "", employeeId: "c", fullName: "Carol C", department: "Product" },
  { day: "2024-01-15", source: "cursor", costType: "metered", costUsd: 0.9, requests: 3, entityKey: "", model: "", employeeId: null, fullName: null, department: null },
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

const employees = [
  { id: "a", fullName: "Alice A", department: "Engineering" },
  { id: "b", fullName: "Bob B", department: "Engineering" },
  { id: "c", fullName: "Carol C", department: "Product" },
  { id: "d", fullName: "Dana D", department: "Data" }, // no spend at all
];

describe("buildPeopleRows", () => {
  it("lists every employee (roster), left-joining this month's spend", () => {
    const rows = buildPeopleRows(facts, employees);
    expect(rows).toHaveLength(4); // all employees, incl. the one with no spend

    const alice = rows.find((r) => r.employeeId === "a")!;
    expect(alice.seatCost).toBe(30);
    expect(alice.metered).toBe(18.75);
    expect(alice.zeroActivity).toBe(false);

    const bob = rows.find((r) => r.employeeId === "b")!;
    expect(bob.zeroActivity).toBe(true); // paying for a seat, no usage

    const dana = rows.find((r) => r.employeeId === "d")!;
    expect(dana.total).toBe(0); // appears with zeros
    expect(dana.zeroActivity).toBe(false); // no seat, so not an "idle seat"
  });
});
