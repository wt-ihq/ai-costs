import type { OpenAICostResponse } from "@/lib/ingest/normalizers/openai";

/** Recorded-shape OpenAI costs fixture: two projects, a few models. */
export const openaiCostFixture: OpenAICostResponse = {
  data: [
    { date: "2026-06-02", project_id: "proj_search", model: "gpt-5", cost_usd: 233.4 },
    { date: "2026-06-06", project_id: "proj_search", model: "gpt-5-mini", cost_usd: 41.1 },
    { date: "2026-06-08", project_id: "proj_assistant", model: "gpt-5", cost_usd: 97.8 },
  ],
};
