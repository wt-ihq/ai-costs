import { describe, expect, it } from "vitest";
import { isPseudoEntity, pseudoExplanation, splitSeatUsageCoverage } from "./data-health";

describe("splitSeatUsageCoverage", () => {
  it("reports seat and usage coverage separately when both cover the month", () => {
    expect(splitSeatUsageCoverage({ seat: "2026-07-01", overage: "2026-07-01" })).toEqual({
      seatDay: "2026-07-01",
      usageDay: "2026-07-01",
      usageBehind: false,
    });
  });

  it("flags usage behind when the usage import is a month older than the seats", () => {
    // The case this exists for: nightly seat sync moved to July, the July
    // usage paste never landed — a single MAX(day) reads 2026-07-01 either way.
    expect(splitSeatUsageCoverage({ seat: "2026-07-01", overage: "2026-06-01" })).toEqual({
      seatDay: "2026-07-01",
      usageDay: "2026-06-01",
      usageBehind: true,
    });
  });

  it("flags usage behind when there is no usage at all", () => {
    expect(splitSeatUsageCoverage({ seat: "2026-07-01" })).toEqual({
      seatDay: "2026-07-01",
      usageDay: null,
      usageBehind: true,
    });
  });

  it("does not flag usage when there are no seats to compare against", () => {
    expect(splitSeatUsageCoverage({ overage: "2026-07-01" })).toEqual({
      seatDay: null,
      usageDay: "2026-07-01",
      usageBehind: false,
    });
  });

  it("reports nothing for a source with no facts", () => {
    expect(splitSeatUsageCoverage({})).toEqual({ seatDay: null, usageDay: null, usageBehind: false });
  });

  it("compares at month grain, so self-dated daily usage past the 1st is not behind", () => {
    // ChatGPT credits CSV facts are self-dated; seat facts are month-stamped.
    expect(splitSeatUsageCoverage({ seat: "2026-07-01", overage: "2026-07-28" })).toMatchObject({
      usageDay: "2026-07-28",
      usageBehind: false,
    });
  });

  it("counts metered as usage and takes the latest across usage cost types", () => {
    expect(splitSeatUsageCoverage({ seat: "2026-07-01", overage: "2026-06-30", metered: "2026-07-10" })).toMatchObject({
      usageDay: "2026-07-10",
      usageBehind: false,
    });
  });

  it("does not count subscription as usage", () => {
    expect(splitSeatUsageCoverage({ seat: "2026-07-01", subscription: "2026-07-01" })).toMatchObject({
      usageDay: null,
      usageBehind: true,
    });
  });
});

describe("isPseudoEntity", () => {
  it.each([
    // by-design person-less entity keys — must never be offered for assignment
    ["unassigned seats", true],
    ["unassigned seats (standard)", true],
    ["unassigned seats (premium)", true],
    ["unkeyed", true], // Anthropic: days with cost but no usage rows
    ["org", true], // OpenAI: org-level costs not tied to a project
    // genuine identities — assignable
    ["tom.grist@intenthq.com", false],
    ["reddy.horcrux@gmail.com", false],
    ["apikey_01Le3wdnpUQSN2SwWZ17PZT5", false],
    ["proj_iBVGlnR1msrsCUrmy5RARv3V", false],
    ["organic@intenthq.com", false], // "org" must match exactly, not as a prefix
  ])("%s -> %s", (key, expected) => {
    expect(isPseudoEntity(key)).toBe(expected);
  });
});

describe("pseudoExplanation", () => {
  it("explains each pseudo-entity class", () => {
    expect(pseudoExplanation("unassigned seats")).toContain("member");
    expect(pseudoExplanation("unassigned seats (premium)")).toContain("member");
    expect(pseudoExplanation("unkeyed")).toContain("Anthropic");
    expect(pseudoExplanation("org")).toContain("org-level");
  });
});
