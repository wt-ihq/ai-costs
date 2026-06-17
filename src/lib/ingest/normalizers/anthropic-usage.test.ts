import { describe, expect, it } from "vitest";
import { priceUsageResult } from "@/lib/ingest/pricing";
import { estimateAndScale, type UsageBucket } from "./anthropic-usage";

describe("priceUsageResult", () => {
  it("prices output tokens by model family", () => {
    // 1M opus output tokens @ $75/MTok = $75
    expect(priceUsageResult({ model: "claude-opus-4-8", output_tokens: 1_000_000 })).toBeCloseTo(75, 5);
    // 1M sonnet input tokens @ $3/MTok = $3
    expect(priceUsageResult({ model: "claude-sonnet-4-6", uncached_input_tokens: 1_000_000 })).toBeCloseTo(3, 5);
  });
  it("applies batch (0.5) and long-context (2x) multipliers", () => {
    expect(priceUsageResult({ model: "claude-opus-4-8", output_tokens: 1_000_000, service_tier: "batch" })).toBeCloseTo(37.5, 5);
    expect(priceUsageResult({ model: "claude-sonnet-4-6", uncached_input_tokens: 1_000_000, context_window: "200k-1M" })).toBeCloseTo(6, 5);
  });
});

describe("estimateAndScale", () => {
  const buckets: UsageBucket[] = [
    {
      starting_at: "2026-06-14T00:00:00Z",
      results: [
        { api_key_id: "k1", model: "claude-opus-4-8", output_tokens: 1_000_000 }, // raw $75
        { api_key_id: "k2", model: "claude-opus-4-8", output_tokens: 1_000_000 }, // raw $75
        { api_key_id: null, model: "claude-sonnet-4-6", uncached_input_tokens: 1_000_000 }, // raw $3 (unkeyed)
      ],
    },
  ];

  it("scales daily estimates to the authoritative Cost API total, split per key", () => {
    const rows = estimateAndScale(buckets, { "2026-06-14": 306 }); // raw total 153 -> scale x2
    const total = rows.reduce((s, r) => s + r.costUsd, 0);
    expect(total).toBeCloseTo(306, 1); // reconciles to the exact Cost API day total
    expect(rows.find((r) => r.apiKeyId === "k1")!.costUsd).toBeCloseTo(150, 1); // 75 * 2
    expect(rows.find((r) => r.apiKeyId === null)!.costUsd).toBeCloseTo(6, 1); // unkeyed retained
  });

  it("falls back to raw list price when a day has no Cost API total", () => {
    const rows = estimateAndScale(buckets, {}); // no costByDay -> scale 1
    expect(rows.reduce((s, r) => s + r.costUsd, 0)).toBeCloseTo(153, 1);
  });
});
