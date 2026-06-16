import type { AnthropicCostResponse } from "@/lib/ingest/normalizers/anthropic";

/** Real-shape Anthropic Cost Report fixture (bucketed; amount is a string). */
export const anthropicCostFixture: AnthropicCostResponse = {
  data: [
    {
      starting_at: "2026-06-09T00:00:00Z",
      ending_at: "2026-06-10T00:00:00Z",
      results: [
        { currency: "USD", amount: "3265.70074222222222225", workspace_id: "wrkspc_prod", model: "claude-opus-4-8" },
        { currency: "USD", amount: "0", workspace_id: "wrkspc_idle", model: null },
      ],
    },
  ],
};
