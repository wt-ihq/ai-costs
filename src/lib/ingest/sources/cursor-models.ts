import type { CursorByUserModelsResponse, CursorModelDailyRow } from "@/lib/ingest/normalizers/cursor-models";
import type { CursorFetchOptions } from "@/lib/ingest/sources/cursor";

/** Injectable so the pipeline can run against fixtures without the network. */
export type CursorModelsFetcher = (opts: CursorFetchOptions) => Promise<CursorByUserModelsResponse>;

const basicAuth = (key: string) => `Basic ${Buffer.from(`${key}:`).toString("base64")}`;

/**
 * Live fetch from the Cursor Analytics API — GET /analytics/by-user/models.
 * Needs CURSOR_ADMIN_API_KEY (admin:* scope). Dates are passed as YYYY-MM-DD;
 * the API caps each request at a 30-day range, so the orchestrator chunks the
 * window before calling this (see run-cursor-models).
 *
 * By-user responses paginate over USERS (not days): we walk `page` until
 * `pagination.hasNextPage` is false, merging each page's `data` (keyed by
 * email) into one object the normalizer can flatten.
 */
export const fetchCursorByUserModels: CursorModelsFetcher = async ({ startDate, endDate }) => {
  const key = process.env.CURSOR_ADMIN_API_KEY;
  if (!key) throw new Error("CURSOR_ADMIN_API_KEY is not set");

  const pageSize = 500; // API max
  const merged: Record<string, CursorModelDailyRow[]> = {};

  for (let page = 1; ; page++) {
    const json = await getModelsPage(key, { startDate, endDate, page, pageSize });
    for (const [email, rows] of Object.entries(json.data ?? {})) {
      merged[email] = [...(merged[email] ?? []), ...(rows ?? [])];
    }
    if (!json.pagination?.hasNextPage) break;
  }
  return { data: merged };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET one page, retrying on 429/5xx with exponential backoff. The by-user
 * analytics endpoints are rate-limited to 50 req/min per team, so a large team
 * paginated over many pages can trip 429 — we ride through it rather than
 * failing the whole window.
 */
async function getModelsPage(
  key: string,
  q: { startDate: string; endDate: string; page: number; pageSize: number },
): Promise<CursorByUserModelsResponse> {
  const params = new URLSearchParams({
    startDate: q.startDate,
    endDate: q.endDate,
    page: String(q.page),
    pageSize: String(q.pageSize),
  });
  const url = `https://api.cursor.com/analytics/by-user/models?${params}`;
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: basicAuth(key) } });
    if (res.ok) return (await res.json()) as CursorByUserModelsResponse;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxAttempts - 1) {
      throw new Error(`Cursor by-user/models ${res.status}: ${await res.text()}`);
    }
    await sleep(Math.min(1000 * 2 ** attempt, 16_000)); // 1s,2s,4s,8s,16s,16s
  }
}
