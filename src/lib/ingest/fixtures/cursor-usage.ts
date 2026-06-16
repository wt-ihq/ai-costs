import type { CursorUsageResponse } from "@/lib/ingest/normalizers/cursor";

/**
 * Real-shape Cursor daily-usage fixture: per-user/day activity rows (no cost).
 * Two known employees + one unknown email; a duplicate day for one user to
 * exercise per-month de-duplication.
 */
export const cursorUsageFixture: CursorUsageResponse = {
  data: [
    { day: "2026-06-01", email: "gareth.jones@intenthq.com", isActive: true, mostUsedModel: "claude-sonnet-4-6", usageBasedReqs: 42 },
    { day: "2026-06-15", email: "gareth.jones@intenthq.com", isActive: true, usageBasedReqs: 5 }, // same user, same month -> deduped
    { day: "2026-06-01", email: "tom.reeve@intenthq.com", isActive: true, usageBasedReqs: 11 },
    { day: "2026-06-02", email: "contractor@external.dev", isActive: false, usageBasedReqs: 3 }, // no matching employee
  ],
};
