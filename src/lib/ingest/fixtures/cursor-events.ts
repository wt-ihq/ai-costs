import type { CursorEventsResponse } from "@/lib/ingest/normalizers/cursor";

const ms = (y: number, mo: number, d: number, h = 12) => Date.UTC(y, mo, d, h).toString();

/**
 * Real-shape Cursor filtered-usage-events fixture: per-event usage-based spend.
 * `chargedCents` is the actually-billed amount; seat-included usage is $0 and
 * must be excluded. Two known employees + one unknown email; a second event for
 * one user/day/model to exercise aggregation.
 */
export const cursorEventsFixture: CursorEventsResponse = {
  totalUsageEventsCount: 6,
  pagination: { numPages: 1, currentPage: 1, pageSize: 1000, hasNextPage: false, hasPreviousPage: false },
  usageEvents: [
    { timestamp: ms(2026, 5, 1), userEmail: "gareth.jones@intenthq.com", model: "claude-sonnet-4-6", kind: "Usage-based", isChargeable: true, chargedCents: 250 },
    { timestamp: ms(2026, 5, 1, 14), userEmail: "gareth.jones@intenthq.com", model: "claude-sonnet-4-6", kind: "Usage-based", isChargeable: true, chargedCents: 150 }, // same user/day/model -> aggregates to 400c
    { timestamp: ms(2026, 5, 2), userEmail: "gareth.jones@intenthq.com", model: "gpt-5", kind: "Usage-based", isChargeable: true, chargedCents: 100 },
    { timestamp: ms(2026, 5, 1), userEmail: "tom.reeve@intenthq.com", model: "claude-opus-4-1", kind: "Usage-based", isChargeable: true, chargedCents: 1000 },
    { timestamp: ms(2026, 5, 1), userEmail: "gareth.jones@intenthq.com", model: "auto", kind: "Included in Business", isChargeable: false, chargedCents: 0 }, // included -> excluded
    { timestamp: ms(2026, 5, 3), userEmail: "contractor@external.dev", model: "claude-sonnet-4-6", kind: "Usage-based", isChargeable: true, chargedCents: 500 }, // no matching employee
  ],
};
