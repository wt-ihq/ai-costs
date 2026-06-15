import type { SpendFact } from "@/lib/types";
import { type Normalizer } from "@/lib/ingest/types";

/**
 * Anthropic Console — Usage report + Cost Report (beta).
 * Grain: per-API-key, per-workspace, per-model, daily. No end-user dimension;
 * attribution flows key `created_by` -> employee downstream (spec §3, §5).
 *
 * TODO: implement against /v1/organizations/usage_report/messages +
 * the Cost Report beta. Keyed on workspace/key id as entity_key.
 */
export interface AnthropicCostResponse {
  data: unknown[];
}

export const normalizeAnthropic: Normalizer<AnthropicCostResponse> = () => {
  // Stub — see spec §3. Emit metered facts keyed on key/workspace id.
  const rows: SpendFact[] = [];
  return rows;
};
