import type { OpenRouterAnalyticsResponse, OpenRouterActivityResponse } from "@/lib/ingest/normalizers/openrouter";
import type { DateWindow } from "./anthropic";

/** Injectable so the pipeline can run against fixtures without the network. */
export type OpenRouterAnalyticsFetcher = (opts: DateWindow) => Promise<OpenRouterAnalyticsResponse>;
export type OpenRouterActivityFetcher = () => Promise<OpenRouterActivityResponse>;

const BASE = "https://openrouter.ai/api/v1";

/**
 * All spend/analytics endpoints need a MANAGEMENT key (Settings → Management
 * Keys — formerly "provisioning key"; read-only, can't call inference), not a
 * regular inference key, which gets 403.
 */
function managementKey(): string {
  const key = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!key) throw new Error("OPENROUTER_MANAGEMENT_KEY is not set");
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with retry on 429/5xx. OpenRouter documents no numeric rate limits on
 * management endpoints but sends Retry-After on 429/503 — honor it (capped),
 * else exponential backoff.
 */
async function openRouterFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${managementKey()}`, ...init.headers },
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxAttempts - 1) {
      throw new Error(`OpenRouter ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const retryAfter = Number(res.headers?.get?.("Retry-After")) * 1000;
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30_000) : Math.min(1000 * 2 ** attempt, 16_000));
  }
}

/**
 * Per-day spend/tokens/requests split by org member and model. `granularity:
 * "day"` adds the `date__day` bucket without counting against the 2-dimension
 * cap, so one call covers the whole spend_facts grain, and an explicit
 * `time_range` reaches past /activity's 30-day window (backfill). Results
 * silently truncate at `limit` with only a metadata flag (the vendor-side
 * analog of our PostgREST gotcha) — better to fail the sync than persist a
 * partial window, so `truncated` throws.
 */
export const fetchOpenRouterAnalytics: OpenRouterAnalyticsFetcher = async ({ startDate, endDate }) => {
  const json = (await openRouterFetch("/analytics/query", {
    method: "POST",
    body: JSON.stringify({
      metrics: ["total_usage", "tokens_total", "request_count"],
      dimensions: ["user", "model"],
      granularity: "day",
      time_range: { start: `${startDate}T00:00:00Z`, end: `${endDate}T00:00:00Z` },
      limit: 10_000,
    }),
  })) as OpenRouterAnalyticsResponse;
  if (json?.data?.metadata?.truncated) {
    throw new Error(`OpenRouter analytics truncated for ${startDate}..${endDate} — narrow the window (row_count=${json.data.metadata.row_count})`);
  }
  return json;
};

/**
 * Exact charged USD per (day × model × endpoint) for the last 30 completed
 * UTC days — the drift check for the beta analytics endpoint above.
 */
export const fetchOpenRouterActivity: OpenRouterActivityFetcher = async () =>
  (await openRouterFetch("/activity")) as OpenRouterActivityResponse;
