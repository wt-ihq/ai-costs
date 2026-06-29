import type { CursorUsageResponse, CursorEventsResponse, CursorUsageEvent, CursorMembersResponse } from "@/lib/ingest/normalizers/cursor";

export interface CursorFetchOptions {
  /** ISO dates; the Admin API allows a 90-day window per request. */
  startDate: string;
  endDate: string;
}

/** Injectable so the pipeline can run against fixtures without the network. */
export type CursorFetcher = (opts: CursorFetchOptions) => Promise<CursorUsageResponse>;
export type CursorEventsFetcher = (opts: CursorFetchOptions) => Promise<CursorEventsResponse>;
export type CursorMembersFetcher = () => Promise<CursorMembersResponse>;

const basicAuth = (key: string) => `Basic ${Buffer.from(`${key}:`).toString("base64")}`;

/**
 * Live fetch from the Cursor Admin API. Needs CURSOR_ADMIN_API_KEY.
 *
 * ⚠ The exact endpoint/response shape must be confirmed against the tenant
 * (spec §3, §11): Cursor's daily-usage endpoint uses Basic auth with the admin
 * key as the username and returns rows we map into CursorUsageResponse. Until
 * a real key + response is available this is structurally complete but
 * unverified — the rest of the pipeline is exercised via fixtures.
 */
export const fetchCursorUsage: CursorFetcher = async ({ startDate, endDate }) => {
  const key = process.env.CURSOR_ADMIN_API_KEY;
  if (!key) throw new Error("CURSOR_ADMIN_API_KEY is not set");

  const res = await fetch("https://api.cursor.com/teams/daily-usage-data", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: basicAuth(key),
    },
    body: JSON.stringify({
      startDate: Date.parse(startDate),
      endDate: Date.parse(endDate),
    }),
  });
  if (!res.ok) {
    throw new Error(`Cursor API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as CursorUsageResponse;
};

/**
 * Live fetch of usage-based ("additional") spend from filtered-usage-events.
 * Both date bounds are INCLUSIVE epoch ms; we make `endDate` exclusive (−1 ms)
 * so calendar windows don't double-count the boundary day. Paginates until
 * `pagination.hasNextPage` is false, accumulating every event.
 */
export const fetchCursorUsageEvents: CursorEventsFetcher = async ({ startDate, endDate }) => {
  const key = process.env.CURSOR_ADMIN_API_KEY;
  if (!key) throw new Error("CURSOR_ADMIN_API_KEY is not set");

  const startMs = Date.parse(startDate);
  const endMs = Date.parse(endDate) - 1; // [start, end) — inclusive bounds otherwise overlap windows
  const pageSize = 1000;
  const usageEvents: CursorUsageEvent[] = [];

  for (let page = 1; ; page++) {
    const json = await postEventsPage(key, { startDate: startMs, endDate: endMs, page, pageSize });
    usageEvents.push(...(json.usageEvents ?? []));
    if (!json.pagination?.hasNextPage) break;
  }
  return { usageEvents };
};

/**
 * Live fetch of the team roster from GET /teams/members — the authoritative
 * seat list (includes paid-but-idle members that daily-usage-data omits).
 */
export const fetchCursorMembers: CursorMembersFetcher = async () => {
  const key = process.env.CURSOR_ADMIN_API_KEY;
  if (!key) throw new Error("CURSOR_ADMIN_API_KEY is not set");
  const res = await fetch("https://api.cursor.com/teams/members", {
    headers: { Accept: "application/json", Authorization: basicAuth(key) },
  });
  if (!res.ok) throw new Error(`Cursor members ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as CursorMembersResponse;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST one page, retrying on 429/5xx with exponential backoff. High-volume
 * months are many pages; firing them back-to-back trips Cursor's rate limit,
 * so we ride through transient 429s rather than failing the whole window.
 */
async function postEventsPage(key: string, body: Record<string, number>): Promise<CursorEventsResponse> {
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.cursor.com/teams/filtered-usage-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth(key) },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as CursorEventsResponse;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxAttempts - 1) {
      throw new Error(`Cursor usage-events ${res.status}: ${await res.text()}`);
    }
    await sleep(Math.min(1000 * 2 ** attempt, 16_000)); // 1s,2s,4s,8s,16s,16s
  }
}
