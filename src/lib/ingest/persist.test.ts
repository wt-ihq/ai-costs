import { describe, expect, it } from "vitest";
import { attachEmployees } from "./persist";
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
