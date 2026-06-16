import type { AnthropicCostResponse } from "@/lib/ingest/normalizers/anthropic";

export interface DateWindow {
  startDate: string;
  endDate: string;
}
export type AnthropicFetcher = (opts: DateWindow & { groupBy?: string }) => Promise<AnthropicCostResponse>;

/**
 * Live fetch from the Anthropic Cost Report (beta). Needs ANTHROPIC_ADMIN_API_KEY.
 * ⚠ Endpoint + response shape must be confirmed against the org (spec §3, §11);
 * the normalizer is fixture-tested. Only this piece needs the key.
 */
export const fetchAnthropicCost: AnthropicFetcher = async ({ startDate, endDate, groupBy }) => {
  const key = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_API_KEY is not set");

  // The Cost Report paginates daily buckets (~7/page by default), so a longer
  // range needs limit + page-following or it silently returns only page 1.
  // Optional groupBy (e.g. workspace_id) breaks the total down for attribution
  // — only valid once verified to reconcile with the org total.
  const all: AnthropicCostResponse["data"] = [];
  let page: string | undefined;
  for (let i = 0; i < 200; i++) {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", startDate);
    url.searchParams.set("ending_at", endDate);
    url.searchParams.set("limit", "31");
    if (groupBy) url.searchParams.append("group_by[]", groupBy);
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

/**
 * List org API keys (id, name, created_by user id). NOTE: the Cost Report
 * cannot group_by api_key_id (only workspace_id / description), so per-KEY
 * spend is not available — workspace is the finest cost grain. Kept for a
 * possible future token-based approximation via the usage report.
 */
export async function fetchAnthropicApiKeys(): Promise<unknown> {
  const key = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/organizations/api_keys?limit=100", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`Anthropic api_keys ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** List org members (user id → email/name) to resolve key creators. */
export async function fetchAnthropicUsers(): Promise<unknown> {
  const key = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/organizations/users?limit=100", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`Anthropic users ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Usage report (messages) grouped by api_key_id (+ model / tier / context),
 * returning token counts — priced downstream as a per-key cost proxy (the Cost
 * API can't group by key). Paginated daily buckets.
 */
export async function fetchAnthropicUsage({ startDate, endDate }: DateWindow): Promise<{ data: unknown[] }> {
  const key = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_API_KEY is not set");
  const all: unknown[] = [];
  let page: string | undefined;
  for (let i = 0; i < 200; i++) {
    const url = new URL("https://api.anthropic.com/v1/organizations/usage_report/messages");
    url.searchParams.set("starting_at", startDate);
    url.searchParams.set("ending_at", endDate);
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    for (const g of ["api_key_id", "model", "service_tier", "context_window"]) url.searchParams.append("group_by[]", g);
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    if (!res.ok) throw new Error(`Anthropic usage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { data?: unknown[]; has_more?: boolean; next_page?: string | null };
    all.push(...(json.data ?? []));
    if (!json.has_more || !json.next_page) break;
    page = json.next_page;
  }
  return { data: all };
}

/** List org workspaces (id → name) so opaque workspace IDs become readable. */
export async function fetchAnthropicWorkspaces(): Promise<unknown> {
  const key = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/organizations/workspaces?limit=100", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`Anthropic workspaces ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
