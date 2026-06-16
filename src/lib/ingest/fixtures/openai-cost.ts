import type { OpenAICostResponse } from "@/lib/ingest/normalizers/openai";

/** Real-shape OpenAI costs fixture (bucketed; amount.value is a string). */
export const openaiCostFixture: OpenAICostResponse = {
  data: [
    {
      start_time_iso: "2026-06-09T00:00:00",
      start_time: 1780963200,
      results: [
        { amount: { value: "75.38441804", currency: "usd" }, project_id: "proj_iBVGlnR1msrsCUrmy5RARv3V", project_name: "Insights Explorer" },
        { amount: { value: "0", currency: "usd" }, project_id: "proj_idle", project_name: "Idle" },
      ],
    },
  ],
};
