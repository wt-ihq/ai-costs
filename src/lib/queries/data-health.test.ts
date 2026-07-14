import { describe, expect, it } from "vitest";
import { isPseudoEntity, pseudoExplanation } from "./data-health";

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
