import { describe, expect, it } from "vitest";
import { matchesVendorKey, parseVendorParam, vendorsInFacts } from "./vendor-filter";

const f = (source: string, model = "") => ({ source, model }) as Parameters<typeof matchesVendorKey>[0];

describe("vendor filter with tool keys", () => {
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
});
