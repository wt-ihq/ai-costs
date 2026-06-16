import type { CursorUsageResponse } from "@/lib/ingest/normalizers/cursor";

/**
 * Recorded-shape Cursor Admin API fixture for tests + the live-DB proof.
 * Two known employees and one unknown email (exercises the Unmatched path).
 */
export const cursorUsageFixture: CursorUsageResponse = {
  data: [
    {
      date: "2026-06-01",
      email: "gareth.jones@intenthq.com",
      model: "claude-sonnet-4-6",
      totalTokens: 120_000,
      requestCount: 42,
      costCents: 1875, // $18.75
    },
    {
      date: "2026-06-01",
      email: "tom.reeve@intenthq.com",
      model: "gpt-5",
      totalTokens: 30_000,
      requestCount: 11,
      costCents: 640, // $6.40
    },
    {
      date: "2026-06-02",
      email: "contractor@external.dev", // no matching employee -> Unmatched
      model: "claude-sonnet-4-6",
      totalTokens: 5_000,
      requestCount: 3,
      costCents: 90,
    },
  ],
};
