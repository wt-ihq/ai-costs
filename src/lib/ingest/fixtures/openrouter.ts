import type { OpenRouterActivityResponse, OpenRouterAnalyticsResponse } from "@/lib/ingest/normalizers/openrouter";

/**
 * Real-shape analytics/query fixture (dimensions ["user","model"], day
 * granularity): a known employee across two models — one metric as a numeric
 * string to exercise defensive parsing — an unknown member, a free-model row
 * (0 cost, real tokens), a null-user row (workbench-style), and a row outside
 * the sync window that must be clamped away.
 */
export const openRouterAnalyticsFixture: OpenRouterAnalyticsResponse = {
  data: {
    data: [
      {
        date__day: "2026-07-01T00:00:00.000Z",
        user: "user_gareth",
        user_email: "Gareth.Jones@intenthq.com",
        model: "anthropic/claude-sonnet-4-6",
        total_usage: 12.5,
        tokens_total: "250000",
        request_count: 40,
      },
      {
        date__day: "2026-07-01T00:00:00.000Z",
        user: "user_gareth",
        user_email: "gareth.jones@intenthq.com",
        model: "openai/gpt-5.2",
        total_usage: "2.25",
        tokens_total: 50000,
        request_count: 10,
      },
      {
        date__day: "2026-07-02T00:00:00.000Z",
        user: "user_ext",
        user_email: "contractor@external.dev",
        model: "anthropic/claude-sonnet-4-6",
        total_usage: 3,
        tokens_total: 60000,
        request_count: 12,
      },
      {
        date__day: "2026-07-02T00:00:00.000Z",
        user: "user_gareth",
        user_email: "gareth.jones@intenthq.com",
        model: "meta-llama/llama-4-maverick:free",
        total_usage: 0,
        tokens_total: 9000,
        request_count: 3,
      },
      {
        date__day: "2026-07-02T00:00:00.000Z",
        user: null,
        user_email: null,
        model: "anthropic/claude-haiku-4-5",
        total_usage: 0.75,
        tokens_total: 15000,
        request_count: 5,
      },
      {
        date__day: "2026-08-01T00:00:00.000Z", // outside [2026-07-01, 2026-08-01)
        user: "user_gareth",
        user_email: "gareth.jones@intenthq.com",
        model: "openai/gpt-5.2",
        total_usage: 99,
        tokens_total: 1,
        request_count: 1,
      },
    ],
    metadata: { row_count: 6, truncated: false },
  },
};

/**
 * Matching /activity fixture: 2026-07-01 agrees with the analytics total
 * (14.75), 2026-07-02 reports 0.60 MORE (an analytics under-report to heal as
 * an `unkeyed` remainder). BYOK spend present but excluded by design.
 */
export const openRouterActivityFixture: OpenRouterActivityResponse = {
  data: [
    { date: "2026-07-01", model: "anthropic/claude-sonnet-4-6", usage: 12.5, byok_usage_inference: 0, requests: 40, prompt_tokens: 200000, completion_tokens: 50000, reasoning_tokens: 0 },
    { date: "2026-07-01", model: "openai/gpt-5.2", usage: 2.25, byok_usage_inference: 0, requests: 10, prompt_tokens: 40000, completion_tokens: 10000, reasoning_tokens: 0 },
    { date: "2026-07-02", model: "anthropic/claude-sonnet-4-6", usage: 3.6, byok_usage_inference: 1.23, requests: 13, prompt_tokens: 50000, completion_tokens: 10000, reasoning_tokens: 0 },
    { date: "2026-07-02", model: "anthropic/claude-haiku-4-5", usage: 0.75, byok_usage_inference: 0, requests: 5, prompt_tokens: 12000, completion_tokens: 3000, reasoning_tokens: 0 },
  ],
};
