import type { SpendFact } from "@/lib/types";
import { SchemaDriftError, type Normalizer } from "@/lib/ingest/types";

/**
 * Cursor Admin API — per-user daily usage with per-event model/token/cost.
 * Usage beyond the seat allowance is metered overage; we emit it as
 * cost_type "metered" keyed on the user email (spec §3).
 *
 * Shape is indicative and fixture-tested; adjust against a real response.
 */
export interface CursorUsageResponse {
  data: Array<{
    date: string; // ISO day
    email: string;
    model?: string;
    totalTokens?: number;
    requestCount?: number;
    costCents: number;
  }>;
}

export const normalizeCursor: Normalizer<CursorUsageResponse> = (raw) => {
  if (!raw || !Array.isArray(raw.data)) {
    throw new SchemaDriftError("cursor", "missing `data` array");
  }

  return raw.data.map((row): SpendFact => {
    if (typeof row.costCents !== "number" || !row.email || !row.date) {
      throw new SchemaDriftError(
        "cursor",
        `row missing email/date/costCents: ${JSON.stringify(row)}`,
      );
    }
    return {
      source: "cursor",
      day: row.date,
      costType: "metered",
      entityKey: row.email.toLowerCase(),
      costUsd: row.costCents / 100,
      tokens: row.totalTokens ?? null,
      requests: row.requestCount ?? null,
      model: row.model ?? null,
    };
  });
};
