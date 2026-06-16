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

  // The Cost Report paginates daily buckets (~7/page by default), so a longer
  // range needs limit + page-following or it silently returns only page 1.
  // NOTE: group_by[]=workspace_id undercounts (returns only the
  // workspace-attributed slice), so we keep the authoritative org-level total.
  const all: AnthropicCostResponse["data"] = [];
  let page: string | undefined;
  for (let i = 0; i < 200; i++) {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", startDate);
    url.searchParams.set("ending_at", endDate);
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as AnthropicCostResponse & { has_more?: boolean; next_page?: string | null };
    all.push(...(json.data ?? []));
    if (!json.has_more || !json.next_page) break;
    page = json.next_page;
  }
  return { data: all };
};
