import { describe, expect, it } from "vitest";
import { matchByName, matchIdentity } from "./identity";

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

const named = [
  { id: "g", fullName: "Gareth Jones" },
  { id: "f", fullName: "Fernando Mora" },
  { id: "j1", fullName: "James Stocker" },
  { id: "j2", fullName: "James Allum" },
];

describe("matchByName (ChatGPT, no email)", () => {
  it("matches an abbreviated 'First L' name with high confidence when unique", () => {
    expect(matchByName("Gareth J", named)).toEqual({
      employeeId: "g",
      method: "alias_rule",
      confidence: "high",
    });
  });

  it("matches an exact full name with high confidence", () => {
    expect(matchByName("Fernando Mora", named)).toMatchObject({
      employeeId: "f",
      confidence: "high",
    });
  });

  it("queues an ambiguous first-name collision rather than guessing", () => {
    // two Jameses -> "James" alone is ambiguous (low = queued), but "James S" is unique
    expect(matchByName("James", named)).toMatchObject({
      employeeId: null,
      confidence: "low",
    });
    expect(matchByName("James S", named)).toMatchObject({
      employeeId: "j1",
      confidence: "high",
    });
  });

  it("returns none for an unknown name", () => {
    expect(matchByName("Nobody Here", named)).toMatchObject({
      employeeId: null,
      confidence: "none",
    });
  });
});
