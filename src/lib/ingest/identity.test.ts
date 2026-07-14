import { describe, expect, it } from "vitest";
import { matchIdentity } from "./identity";

const employees = [
  { id: "e1", email: "alice@intenthq.com" },
  { id: "e2", email: "bob@intenthq.com" },
];

describe("matchIdentity", () => {
  it("matches on exact email, case-insensitively", () => {
    expect(matchIdentity("Alice@IntentHQ.com", employees)).toEqual({
      employeeId: "e1",
      method: "exact_email",
    });
  });

  it("falls back to alias rules", () => {
    const aliases = [{ alias: "a.smith@gmail.com", employeeEmail: "alice@intenthq.com" }];
    expect(matchIdentity("a.smith@gmail.com", employees, aliases)).toEqual({
      employeeId: "e1",
      method: "alias_rule",
    });
  });

  it("returns unmatched (never drops) for unknown identities", () => {
    expect(matchIdentity("ghost@elsewhere.com", employees)).toEqual({
      employeeId: null,
      method: "unmatched",
    });
  });

  it("treats missing email as unmatched", () => {
    expect(matchIdentity(undefined, employees)).toEqual({
      employeeId: null,
      method: "unmatched",
    });
  });
});
