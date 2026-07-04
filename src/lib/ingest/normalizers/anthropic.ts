/**
 * Anthropic Console — Cost Report (GET /v1/organizations/cost_report).
 * Real shape (confirmed against the org): time buckets, each with `results[]`.
 * ⚠ `amount` is a decimal string in CENTS — the live pipeline divides by 100
 * (see run-platforms.ts:syncAnthropic). `workspace_id`/`model` are populated
 * when the request groups by them (null = org-aggregate).
 *
 * NOTE: a `normalizeAnthropic` fact normalizer used to live here, reading
 * `amount` as DOLLARS — it was dead code (production goes through
 * estimateAndScale) and disagreed with the live pipeline by 100×, so it was
 * removed. Only the response type remains.
 */
export interface AnthropicCostResponse {
  data: Array<{
    starting_at: string; // ISO datetime
    ending_at?: string;
    results: Array<{
      amount: string;
      currency?: string;
      workspace_id?: string | null;
      model?: string | null;
    }>;
  }>;
}
