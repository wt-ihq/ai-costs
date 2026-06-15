import type { SpendFact } from "@/lib/types";
import { SchemaDriftError, type Normalizer } from "@/lib/ingest/types";

/**
 * Anthropic Console — Cost Report (beta). Grain: per-API-key / per-workspace /
 * per-model / daily. No end-user dimension; attribution flows the key's
 * created_by → employee downstream (spec §3, §5). entity_key = api key id.
 *
 * ⚠ Shape is indicative and must be confirmed against the real Cost Report +
 * usage_report/messages responses (spec §11); the rest of the pipeline is
 * fixture-tested.
 */
export interface AnthropicCostResponse {
  data: Array<{
    date: string;
    api_key_id: string;
    workspace_id?: string;
    model: string;
    cost_usd: number;
    input_tokens?: number;
    output_tokens?: number;
  }>;
}

export const normalizeAnthropic: Normalizer<AnthropicCostResponse> = (raw) => {
  if (!raw || !Array.isArray(raw.data)) {
    throw new SchemaDriftError("anthropic", "missing `data` array");
  }
  return raw.data.map((row): SpendFact => {
    if (typeof row.cost_usd !== "number" || !row.api_key_id || !row.date) {
      throw new SchemaDriftError("anthropic", `bad row: ${JSON.stringify(row)}`);
    }
    return {
      source: "anthropic",
      day: row.date,
      costType: "metered",
      entityKey: row.api_key_id,
      costUsd: row.cost_usd,
      tokens: (row.input_tokens ?? 0) + (row.output_tokens ?? 0) || null,
      model: row.model ?? "",
    };
  });
};
