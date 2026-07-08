import { describe, expect, it } from "vitest";
import { parseVendorParam, vendorsInFacts } from "./vendor-filter";

describe("vendorsInFacts", () => {
  it("returns unique vendors sorted by display label", () => {
    const facts = [
      { source: "openai" as const },
      { source: "anthropic" as const },
      { source: "openai" as const },
      { source: "cursor" as const },
    ];
    // Labels: Anthropic, Cursor, OpenAI
    expect(vendorsInFacts(facts)).toEqual(["anthropic", "cursor", "openai"]);
  });

  it("returns [] for no facts", () => {
    expect(vendorsInFacts([])).toEqual([]);
  });
});

describe("parseVendorParam", () => {
  const present = ["anthropic", "cursor"] as const;

  it("accepts a vendor that is present", () => {
    expect(parseVendorParam("cursor", [...present])).toBe("cursor");
  });

  it("falls back to all when absent, unknown, or not present in scope", () => {
    expect(parseVendorParam(undefined, [...present])).toBe("all");
    expect(parseVendorParam("not-a-vendor", [...present])).toBe("all");
    expect(parseVendorParam("openai", [...present])).toBe("all"); // valid vendor, no data in scope
  });
});
