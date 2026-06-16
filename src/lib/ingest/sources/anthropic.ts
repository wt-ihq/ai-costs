import type { AnthropicCostResponse } from "@/lib/ingest/normalizers/anthropic";

export interface DateWindow {
  startDate: string;
  endDate: string;
}
export type AnthropicFetcher = (opts: DateWindow) => Promise<AnthropicCostResponse>;

/**
 * Live fetch from the Anthropic Cost Report (beta). Needs ANTHROPIC_ADMIN_API_KEY.
 * ⚠ Endpoint + response shape must be confirmed against the org (spec §3, §11);
 * the normalizer is fixture-tested. Only this piece needs the key.
 */
export const fetchAnthropicCost: AnthropicFetcher = async ({ startDate, endDate }) => {
  const key = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_API_KEY is not set");

  const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
  url.searchParams.set("starting_at", startDate);
  url.searchParams.set("ending_at", endDate);
  // Break the org total down by workspace so spend is attributable (spec §5)
  // rather than a single "org" bucket.
  url.searchParams.append("group_by[]", "workspace_id");
  const res = await fetch(url, {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AnthropicCostResponse;
};
