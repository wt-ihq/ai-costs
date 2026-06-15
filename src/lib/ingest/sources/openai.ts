import type { OpenAICostResponse } from "@/lib/ingest/normalizers/openai";
import type { DateWindow } from "./anthropic";

export type OpenAIFetcher = (opts: DateWindow) => Promise<OpenAICostResponse>;

/**
 * Live fetch from the OpenAI organization costs endpoint. Needs the
 * Org-Owner-scoped OPENAI_ADMIN_API_KEY.
 * ⚠ Endpoint + response shape must be confirmed against the org (spec §3, §11);
 * the normalizer is fixture-tested. Only this piece needs the key.
 */
export const fetchOpenAICost: OpenAIFetcher = async ({ startDate, endDate }) => {
  const key = process.env.OPENAI_ADMIN_API_KEY;
  if (!key) throw new Error("OPENAI_ADMIN_API_KEY is not set");

  const url = new URL("https://api.openai.com/v1/organization/costs");
  url.searchParams.set("start_time", String(Math.floor(Date.parse(startDate) / 1000)));
  url.searchParams.set("end_time", String(Math.floor(Date.parse(endDate) / 1000)));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  return (await res.json()) as OpenAICostResponse;
};
