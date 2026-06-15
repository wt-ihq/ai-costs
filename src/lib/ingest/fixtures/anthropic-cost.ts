import type { AnthropicCostResponse } from "@/lib/ingest/normalizers/anthropic";

/** Recorded-shape Anthropic Cost Report fixture: two keys, a few models. */
export const anthropicCostFixture: AnthropicCostResponse = {
  data: [
    { date: "2026-06-03", api_key_id: "ak_prod_ingest", model: "claude-opus-4-8", cost_usd: 412.5, input_tokens: 8_000_000, output_tokens: 900_000 },
    { date: "2026-06-07", api_key_id: "ak_prod_ingest", model: "claude-sonnet-4-6", cost_usd: 88.2, input_tokens: 3_000_000, output_tokens: 400_000 },
    { date: "2026-06-09", api_key_id: "ak_research", model: "claude-opus-4-8", cost_usd: 156.0, input_tokens: 2_500_000, output_tokens: 300_000 },
  ],
};
