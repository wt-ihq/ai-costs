import type { DateWindow } from "@/lib/ingest/sources/anthropic";
import type { FocusCharge } from "@/lib/ingest/normalizers/vercel";
import { SchemaDriftError } from "@/lib/ingest/types";

export type VercelFetcher = (window: DateWindow) => Promise<FocusCharge[]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * FOCUS v1.3 billing charges for the team, as JSONL (1-day granularity,
 * exclusive-end window — the API's convention matches ours). Retries 429/5xx
 * with exponential backoff; a malformed line throws (money is never silently
 * dropped).
 */
export const fetchVercelCharges: VercelFetcher = async (window) => {
  const token = process.env.VERCEL_BILLING_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token || !teamId) throw new Error("VERCEL_BILLING_TOKEN / VERCEL_TEAM_ID not set");

  const url = `https://api.vercel.com/v1/billing/charges?from=${window.startDate}&to=${window.endDate}&teamId=${encodeURIComponent(teamId)}`;
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/jsonl" } });
    if (res.ok) {
      const lines = (await res.text()).split("\n").filter((l) => l.trim());
      return lines.map((line) => {
        try {
          return JSON.parse(line) as FocusCharge;
        } catch {
          throw new SchemaDriftError("vercel", `malformed JSONL line "${line.slice(0, 120)}"`);
        }
      });
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxAttempts - 1) {
      throw new Error(`Vercel billing ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(Math.min(1000 * 2 ** attempt, 16_000));
  }
};
