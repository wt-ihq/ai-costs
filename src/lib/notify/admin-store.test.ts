import { describe, expect, it } from "vitest";
import { lastSentLabels, summariseLastRun } from "./admin-store";

const row = (employee_id: string, mode: string, cadence: string, updated_at: string, status = "sent") => ({ employee_id, mode, cadence, status, updated_at });

describe("lastSentLabels", () => {
  it("takes each person's newest LIVE send; a preview only when they have no live one", () => {
    const labels = lastSentLabels([
      row("a", "preview", "daily", "2026-09-30T07:01:00Z"),
      row("b", "preview", "weekly", "2026-09-29T07:01:00Z"),
      row("a", "live", "weekly", "2026-09-28T07:01:00Z"),
      row("a", "live", "monthly", "2026-09-03T07:01:00Z"),
      row("b", "preview", "daily", "2026-09-27T07:01:00Z"),
    ]);
    expect(labels.get("a")).toBe("weekly · 2026-09-28");
    expect(labels.get("b")).toBe("preview · weekly · 2026-09-29");
    expect(labels.has("c")).toBe(false);
  });
});

describe("summariseLastRun", () => {
  it("is null with no sends", () => {
    expect(summariseLastRun([])).toBeNull();
  });

  it("reports the latest day's mode, cadences and counts", () => {
    expect(
      summariseLastRun([
        row("a", "preview", "weekly", "2026-09-28T07:02:00Z"),
        row("b", "preview", "daily", "2026-09-28T07:01:00Z", "skipped"),
        row("c", "preview", "daily", "2026-09-28T07:00:30Z", "failed"),
        row("d", "live", "daily", "2026-09-27T07:00:00Z"),
      ]),
    ).toEqual({ day: "2026-09-28", mode: "preview", cadences: ["daily", "weekly"], sent: 1, skipped: 1, failed: 1, plusPreview: 0 });
  });

  it("shows live counts when both modes ran that day, plus the preview count", () => {
    expect(
      summariseLastRun([
        row("a", "preview", "weekly", "2026-09-28T09:00:00Z"),
        row("a", "preview", "daily", "2026-09-28T08:00:00Z"),
        row("b", "live", "weekly", "2026-09-28T07:01:00Z"),
        row("c", "live", "weekly", "2026-09-28T07:00:00Z", "failed"),
      ]),
    ).toEqual({ day: "2026-09-28", mode: "live", cadences: ["daily", "weekly"], sent: 1, skipped: 0, failed: 1, plusPreview: 2 });
  });
});
