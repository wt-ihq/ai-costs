import { describe, expect, it } from "vitest";
import { chunkWindows } from "./run-cursor-models";

describe("chunkWindows", () => {
  it("returns a single window when the range is under the cap", () => {
    expect(chunkWindows("2026-06-01", "2026-06-08")).toEqual([
      { startDate: "2026-06-01", endDate: "2026-06-07" },
    ]);
  });

  it("never produces a window wider than the 30-day API cap", () => {
    // A full 31-day month-to-date window (1st → 1st of next month) must split.
    const windows = chunkWindows("2026-07-01", "2026-08-01");
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      const span = (Date.parse(w.endDate) - Date.parse(w.startDate)) / 86_400_000;
      expect(span).toBeLessThanOrEqual(30);
    }
  });

  it("covers the whole range without gaps", () => {
    const windows = chunkWindows("2026-07-01", "2026-08-01");
    expect(windows[0].startDate).toBe("2026-07-01");
    // Consecutive chunks abut (next start = prev end + 1 day).
    for (let i = 1; i < windows.length; i++) {
      const prevEnd = Date.parse(windows[i - 1].endDate);
      const thisStart = Date.parse(windows[i].startDate);
      expect((thisStart - prevEnd) / 86_400_000).toBe(1);
    }
  });
});
