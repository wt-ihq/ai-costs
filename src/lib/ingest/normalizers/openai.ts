import type { SpendFact } from "@/lib/types";
import { type Normalizer } from "@/lib/ingest/types";

/**
 * OpenAI Developer Platform — /v1/organization/usage/* + /v1/organization/costs.
 * Grain: per-project, per-key, daily; per-user_id only when apps pass it
 * (treated as a bonus dimension — project-level is the dependable grain, §11).
 *
 * TODO: implement against the org usage + costs endpoints. Keyed on project id.
 */
export interface OpenAICostResponse {
  data: unknown[];
}

export const normalizeOpenAI: Normalizer<OpenAICostResponse> = () => {
  const rows: SpendFact[] = [];
  return rows;
};
