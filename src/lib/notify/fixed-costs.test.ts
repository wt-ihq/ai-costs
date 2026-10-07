import { describe, expect, it } from "vitest";
import { fixedCostsFor, fixedCostsForTeam, NO_FIXED_COST_SETTINGS, type FixedCostSettings } from "./fixed-costs";

const settings: FixedCostSettings = { orgInclude: false, departments: { Design: true, Sales: false }, employees: { p1: false, p2: true } };

describe("fixedCostsFor", () => {
  it("person override beats team override beats the organisation default", () => {
    expect(fixedCostsFor(settings, { id: "p1", department: "Design" })).toEqual({ include: false, source: "person" });
    expect(fixedCostsFor(settings, { id: "p9", department: "Design" })).toEqual({ include: true, source: "team" });
    expect(fixedCostsFor(settings, { id: "p2", department: "Sales" })).toEqual({ include: true, source: "person" });
    expect(fixedCostsFor(settings, { id: "p9", department: "Eng" })).toEqual({ include: false, source: "default" });
    expect(fixedCostsFor(settings, { id: "p9", department: null })).toEqual({ include: false, source: "default" });
  });
  it("defaults to excluding fixed costs when nothing is set", () => {
    expect(fixedCostsFor(NO_FIXED_COST_SETTINGS, { id: "p1", department: "Design" })).toEqual({ include: false, source: "default" });
    expect(fixedCostsFor({ ...NO_FIXED_COST_SETTINGS, orgInclude: true }, { id: "p1", department: "Design" })).toEqual({ include: true, source: "default" });
  });
});

describe("fixedCostsForTeam", () => {
  it("a team digest uses the team override, else the default", () => {
    expect(fixedCostsForTeam(settings, "Design")).toEqual({ include: true, source: "team" });
    expect(fixedCostsForTeam(settings, "Eng")).toEqual({ include: false, source: "default" });
  });
});
