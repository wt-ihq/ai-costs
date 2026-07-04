import { describe, expect, it } from "vitest";
import { priceUsageResult } from "@/lib/ingest/pricing";
import { estimateAndScale, type UsageBucket } from "./anthropic-usage";

describe("priceUsageResult", () => {
  it("prices output tokens by model family", () => {
    // 1M opus output tokens @ $25/MTok = $25
    expect(priceUsageResult({ model: "claude-opus-4-8", output_tokens: 1_000_000 })).toBeCloseTo(25, 5);
    // 1M sonnet input tokens @ $3/MTok = $3
    expect(priceUsageResult({ model: "claude-sonnet-4-6", uncached_input_tokens: 1_000_000 })).toBeCloseTo(3, 5);
    // 1M fable output tokens @ $50/MTok = $50
    expect(priceUsageResult({ model: "claude-fable-5", output_tokens: 1_000_000 })).toBeCloseTo(50, 5);
    // 1M haiku input tokens @ $1/MTok = $1
    expect(priceUsageResult({ model: "claude-haiku-4-5", uncached_input_tokens: 1_000_000 })).toBeCloseTo(1, 5);
  });
  it("applies batch (0.5) and Sonnet-only long-context multipliers", () => {
    expect(priceUsageResult({ model: "claude-opus-4-8", output_tokens: 1_000_000, service_tier: "batch" })).toBeCloseTo(12.5, 5);
    // Sonnet >200k: 2x input
    expect(priceUsageResult({ model: "claude-sonnet-4-6", uncached_input_tokens: 1_000_000, context_window: "200k-1M" })).toBeCloseTo(6, 5);
    // Sonnet >200k: 1.5x output
    expect(priceUsageResult({ model: "claude-sonnet-4-6", output_tokens: 1_000_000, context_window: "200k-1M" })).toBeCloseTo(22.5, 5);
    // Current Opus has NO long-context premium (1M at standard rates)
    expect(priceUsageResult({ model: "claude-opus-4-8", uncached_input_tokens: 1_000_000, context_window: "200k-1M" })).toBeCloseTo(5, 5);
  });
  it("applies cache multipliers to input pricing", () => {
    // cache read 0.1x, 5m write 1.25x, 1h write 2x on opus $5/MTok input
    expect(priceUsageResult({ model: "claude-opus-4-8", cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.5, 5);
    expect(priceUsageResult({ model: "claude-opus-4-8", cache_creation: { ephemeral_5m_input_tokens: 1_000_000 } })).toBeCloseTo(6.25, 5);
    expect(priceUsageResult({ model: "claude-opus-4-8", cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } })).toBeCloseTo(10, 5);
  });
});

describe("estimateAndScale", () => {
  const buckets: UsageBucket[] = [
    {
      starting_at: "2026-06-14T00:00:00Z",
      results: [
        { api_key_id: "k1", model: "claude-opus-4-8", output_tokens: 1_000_000 }, // raw $25
        { api_key_id: "k2", model: "claude-opus-4-8", output_tokens: 1_000_000 }, // raw $25
        { api_key_id: null, model: "claude-sonnet-4-6", uncached_input_tokens: 1_000_000 }, // raw $3 (unkeyed)
      ],
    },
  ];

  it("scales daily estimates to the authoritative Cost API total, split per key", () => {
    const rows = estimateAndScale(buckets, { "2026-06-14": 106 }); // raw total 53 -> scale x2
    const total = rows.reduce((s, r) => s + r.costUsd, 0);
    expect(total).toBeCloseTo(106, 1); // reconciles to the exact Cost API day total
    expect(rows.find((r) => r.apiKeyId === "k1")!.costUsd).toBeCloseTo(50, 1); // 25 * 2
    expect(rows.find((r) => r.apiKeyId === null)!.costUsd).toBeCloseTo(6, 1); // unkeyed retained
  });

  it("falls back to raw list price when a day has no Cost API total", () => {
    const rows = estimateAndScale(buckets, {}); // no costByDay -> scale 1
    expect(rows.reduce((s, r) => s + r.costUsd, 0)).toBeCloseTo(53, 1);
  });
});
