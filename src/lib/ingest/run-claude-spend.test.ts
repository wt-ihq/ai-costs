import { describe, expect, it } from "vitest";
import { monthWindow, recentClaudeMonths } from "./run-claude-spend";

describe("monthWindow", () => {
  it("is the month, exclusive end", () => {
    expect(monthWindow("2026-10")).toEqual({ startDate: "2026-10-01", endDate: "2026-11-01" });
    expect(monthWindow("2026-12")).toEqual({ startDate: "2026-12-01", endDate: "2027-01-01" });
  });
});

describe("recentClaudeMonths", () => {
  it("is last month and this month (the nightly self-heal)", () => {
    expect(recentClaudeMonths(new Date("2026-10-20T06:00:00Z"))).toEqual(["2026-09", "2026-10"]);
    expect(recentClaudeMonths(new Date("2027-01-02T06:00:00Z"))).toEqual(["2026-12", "2027-01"]);
  });
});
