import type { CursorUsageResponse } from "@/lib/ingest/normalizers/cursor";

export interface CursorFetchOptions {
  /** ISO dates; the Admin API allows a 90-day window per request. */
  startDate: string;
  endDate: string;
}

/** Injectable so the pipeline can run against fixtures without the network. */
export type CursorFetcher = (opts: CursorFetchOptions) => Promise<CursorUsageResponse>;

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
      Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
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
