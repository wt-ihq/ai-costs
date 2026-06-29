import type { CursorByUserModelsResponse } from "@/lib/ingest/normalizers/cursor-models";

/**
 * Real-shape Cursor by-user/models fixture: `data` keyed by email, each a list
 * of per-day rows with a model_breakdown. Two known employees + one unknown
 * email; one user spans two days on the same model (exercises summing) and uses
 * two models; a zero-message entry that must be dropped.
 */
export const cursorModelsFixture: CursorByUserModelsResponse = {
  data: {
    "gareth.jones@intenthq.com": [
      {
        date: "2026-06-01",
        model_breakdown: {
          "claude-sonnet-4.5": { messages: 120, users: 1 },
          "gpt-4o": { messages: 30, users: 1 },
        },
      },
      {
        date: "2026-06-02",
        model_breakdown: {
          "claude-sonnet-4.5": { messages: 80, users: 1 },
          auto: { messages: 0, users: 1 }, // zero messages -> dropped
        },
      },
    ],
    "tom.reeve@intenthq.com": [
      {
        date: "2026-06-01",
        model_breakdown: {
          "claude-opus-4.1": { messages: 45, users: 1 },
        },
      },
    ],
    "contractor@external.dev": [
      {
        date: "2026-06-03",
        model_breakdown: {
          "gpt-4o": { messages: 12, users: 1 },
        },
      },
    ],
  },
  pagination: {
    page: 1,
    pageSize: 500,
    totalUsers: 3,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  },
};
