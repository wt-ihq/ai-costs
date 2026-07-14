import { describe, expect, it } from "vitest";
import { toSeatMembers } from "./run-chatgpt-seats";

const employees = [
  { id: "e1", email: "alex.morgan@intenthq.com" },
  { id: "e2", email: "jamie.lee@intenthq.com" },
];

describe("toSeatMembers", () => {
  it("dedupes case-insensitively, resolves employees by exact email, keeps unknowns unattributed", () => {
    const members = toSeatMembers(
      ["Alex.Morgan@intenthq.com", "alex.morgan@intenthq.com", "jamie.lee@intenthq.com", "ghost@intenthq.com", "  "],
      employees,
    );
    expect(members).toEqual([
      { entityKey: "alex.morgan@intenthq.com", employeeId: "e1" },
      { entityKey: "jamie.lee@intenthq.com", employeeId: "e2" },
      { entityKey: "ghost@intenthq.com", employeeId: null }, // kept, unattributed (never dropped)
    ]);
  });
});
