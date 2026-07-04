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

  // The costs endpoint paginates daily buckets (default 7/page), so follow
  // next_page with a higher limit or a longer range only returns page 1.
  const MAX_PAGES = 200;
  const all: OpenAICostResponse["data"] = [];
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set("start_time", String(Math.floor(Date.parse(startDate) / 1000)));
    url.searchParams.set("end_time", String(Math.floor(Date.parse(endDate) / 1000)));
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as OpenAICostResponse & { has_more?: boolean; next_page?: string | null };
    all.push(...(json.data ?? []));
    if (!json.has_more || !json.next_page) return { data: all };
    page = json.next_page;
  }
  // Better to fail than to persist a silently-truncated window.
  throw new Error(`OpenAI costs: exceeded ${MAX_PAGES} pages for ${startDate}..${endDate}`);
};
