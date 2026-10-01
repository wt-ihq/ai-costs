import { describe, expect, it } from "vitest";
import { previewHref } from "./subject";

const ID = "0b7c7f5e-9d2a-4c1e-8f3a-2a6b9c1d4e5f";

describe("previewHref", () => {
  it("links a person with the existing preview parameter", () => {
    expect(previewHref({ kind: "person", employeeId: ID }, "weekly")).toBe(`/data?tab=notifications&preview=${ID}&cadence=weekly`);
    expect(previewHref({ kind: "person", employeeId: ID }, "daily", "2026-09-27")).toBe(`/data?tab=notifications&preview=${ID}&cadence=daily&at=2026-09-27`);
  });

  it("links a team with its URL-encoded department", () => {
    expect(previewHref({ kind: "team", department: "Data Science" }, "monthly", "2026-08")).toBe("/data?tab=notifications&team=Data%20Science&cadence=monthly&at=2026-08");
    expect(previewHref({ kind: "team", department: "R&D / Ops?#" }, "weekly")).toBe("/data?tab=notifications&team=R%26D%20%2F%20Ops%3F%23&cadence=weekly");
  });

  it("omits the period when there is none (the latest complete one is used)", () => {
    expect(previewHref({ kind: "team", department: "Eng" }, "weekly", null)).toBe("/data?tab=notifications&team=Eng&cadence=weekly");
  });
});
