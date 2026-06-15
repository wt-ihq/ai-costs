import type { SpendFact } from "@/lib/types";
import { SchemaDriftError, type Normalizer } from "@/lib/ingest/types";

/**
 * OpenAI Developer Platform — /v1/organization/costs (+ usage). Grain:
 * per-project / per-model / daily; per-user only when apps pass user_id
 * (treated as a bonus, project is the dependable grain — spec §11).
 * entity_key = project id; attribution via the project's created_by → employee.
 *
 * ⚠ Shape is indicative and must be confirmed against the real costs/usage
 * endpoints (spec §11); the rest of the pipeline is fixture-tested.
 */
export interface OpenAICostResponse {
  data: Array<{
    date: string;
    project_id: string;
    model?: string;
    cost_usd: number;
  }>;
}

export const normalizeOpenAI: Normalizer<OpenAICostResponse> = (raw) => {
  if (!raw || !Array.isArray(raw.data)) {
    throw new SchemaDriftError("openai", "missing `data` array");
  }
  return raw.data.map((row): SpendFact => {
    if (typeof row.cost_usd !== "number" || !row.project_id || !row.date) {
      throw new SchemaDriftError("openai", `bad row: ${JSON.stringify(row)}`);
    }
    return {
      source: "openai",
      day: row.date,
      costType: "metered",
      entityKey: row.project_id,
      costUsd: row.cost_usd,
      model: row.model ?? "",
    };
  });
};
