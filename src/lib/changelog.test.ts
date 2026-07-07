import { describe, expect, it } from "vitest";
import { CHANGELOG, hasUnseen } from "./changelog";

describe("hasUnseen", () => {
  it("is true for a first-time visitor (no stored date)", () => {
    expect(hasUnseen("2026-07-07", null)).toBe(true);
  });

  it("is true when an entry is newer than the last seen date", () => {
    expect(hasUnseen("2026-07-07", "2026-06-30")).toBe(true);
  });

  it("is false when the latest entry has been seen", () => {
    expect(hasUnseen("2026-07-07", "2026-07-07")).toBe(false);
  });

  it("is false when the stored date is somehow newer", () => {
    expect(hasUnseen("2026-07-07", "2026-08-01")).toBe(false);
  });
});

describe("CHANGELOG", () => {
  it("has valid ISO dates and non-empty content", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    for (const entry of CHANGELOG) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.title.trim()).not.toBe("");
      expect(entry.items.length).toBeGreaterThan(0);
    }
  });

  it("is sorted newest-first", () => {
    const dates = CHANGELOG.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});
