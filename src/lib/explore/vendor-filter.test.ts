import { describe, expect, it } from "vitest";
import { matchesVendorKey, parseVendorParam, vendorsInFacts } from "./vendor-filter";

const f = (source: string, model = "") => ({ source, model }) as Parameters<typeof matchesVendorKey>[0];

describe("vendor filter with tool keys", () => {
  it("returns unique vendors sorted by display label", () => {
    // Labels: Anthropic API, Cursor, OpenAI API
    expect(vendorsInFacts([f("openai"), f("anthropic"), f("openai"), f("cursor")])).toEqual([
      "anthropic",
      "cursor",
      "openai",
    ]);
  });

  it("returns [] for no facts", () => {
    expect(vendorsInFacts([])).toEqual([]);
  });

  it("lists tools as their own keys, sorted by label", () => {
    expect(vendorsInFacts([f("cursor"), f("other", "Perplexity"), f("other", "ElevenLabs"), f("other", "Perplexity")]))
      .toEqual(["cursor", "other:ElevenLabs", "other:Perplexity"]);
  });

  it("matches facts to keys", () => {
    expect(matchesVendorKey(f("other", "Perplexity"), "other:Perplexity")).toBe(true);
    expect(matchesVendorKey(f("other", "ElevenLabs"), "other:Perplexity")).toBe(false);
    expect(matchesVendorKey(f("cursor"), "cursor")).toBe(true);
    expect(matchesVendorKey(f("cursor"), "other:Perplexity")).toBe(false);
  });

  it("validates ?vendor= against present keys", () => {
    expect(parseVendorParam("other:Perplexity", ["cursor", "other:Perplexity"])).toBe("other:Perplexity");
    expect(parseVendorParam("other:Ghost", ["cursor"])).toBe("all");
  });

  it("accepts a vendor that is present", () => {
    expect(parseVendorParam("cursor", ["anthropic", "cursor"])).toBe("cursor");
    expect(parseVendorParam("other:Perplexity", ["cursor", "other:Perplexity"])).toBe("other:Perplexity");
  });

  it("falls back to all when absent, unknown, or not present in scope", () => {
    const present = ["anthropic", "cursor"];
    expect(parseVendorParam(undefined, present)).toBe("all");
    expect(parseVendorParam("not-a-vendor", present)).toBe("all");
    expect(parseVendorParam("openai", present)).toBe("all"); // valid vendor, no data in scope
  });
});
