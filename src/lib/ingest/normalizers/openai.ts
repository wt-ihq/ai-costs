import type { SpendFact } from "@/lib/types";
import { SchemaDriftError, type Normalizer } from "@/lib/ingest/types";

/**
 * OpenAI Developer Platform — GET /v1/organization/costs.
 * Real shape (confirmed against the org): daily buckets, each with `results[]`
 * carrying `amount.value` (decimal string) and `project_id`/`project_name`.
 * entity_key = project id; attribution flows via the project's owner (spec §5).
 */
export interface OpenAICostResponse {
  data: Array<{
    start_time_iso?: string;
    start_time?: number; // unix seconds (fallback)
    results: Array<{
      amount: { value: string; currency?: string };
      project_id?: string | null;
      project_name?: string | null;
      model?: string | null;
    }>;
  }>;
}

export const normalizeOpenAI: Normalizer<OpenAICostResponse> = (raw) => {
  if (!raw || !Array.isArray(raw.data)) {
    throw new SchemaDriftError("openai", "missing `data` array");
  }
  const facts: SpendFact[] = [];
  for (const bucket of raw.data) {
    // Prefer the ISO date; fall back to the unix start_time. Skip buckets we
    // can't date (some ranges return undatable buckets) rather than emit an
    // empty `day` that the DB rejects.
    const day = bucket.start_time_iso
      ? bucket.start_time_iso.slice(0, 10)
      : typeof bucket.start_time === "number"
        ? new Date(bucket.start_time * 1000).toISOString().slice(0, 10)
        : "";
    if (!day) continue;
    for (const r of bucket.results ?? []) {
      const cost = Number(r.amount?.value);
      if (!Number.isFinite(cost) || cost === 0) continue;
      facts.push({
        source: "openai",
        day,
        costType: "metered",
        entityKey: r.project_id ?? "org",
        costUsd: cost,
        model: r.model ?? "",
      });
    }
  }
  return facts;
};
