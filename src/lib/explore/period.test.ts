import { describe, expect, it } from "vitest";
import {
  parsePeriod, currentPeriod, allTimePeriod, stepPeriod, enumerateBuckets,
  canStepForward, canStepBack,
} from "./period";

const NOW = new Date("2026-06-17T12:00:00Z"); // June 2026, Q2

describe("allTimePeriod", () => {
  it("spans from the earliest data month to the end of the current month, no stepping", () => {
    const p = allTimePeriod("2025-05", NOW);
    expect(p).toMatchObject({ granularity: "all", anchor: "all", from: "2025-05-01", toExclusive: "2026-07-01", label: "All time", isCurrent: true });
    expect(canStepForward(p)).toBe(false);
    expect(canStepBack(p, "2025-05")).toBe(false);
  });
  it("enumerates monthly buckets across the full span with year-aware labels", () => {
    const b = enumerateBuckets(allTimePeriod("2025-05", NOW)); // May 2025 .. Jun 2026 = 14 months
    expect(b).toHaveLength(14);
    expect(b[0]).toMatchObject({ key: "2025-05", label: "May 25" });
    expect(b[13]).toMatchObject({ key: "2026-06", label: "Jun 26" });
  });
});

describe("parsePeriod", () => {
  it("parses a month and marks the current month to-date", () => {
    expect(parsePeriod("2026-06", NOW)).toMatchObject({
      granularity: "month", anchor: "2026-06",
      from: "2026-06-01", toExclusive: "2026-07-01",
      label: "June 2026", isCurrent: true,
    });
  });
  it("parses a past month (not current)", () => {
    expect(parsePeriod("2026-05", NOW)).toMatchObject({ label: "May 2026", isCurrent: false, from: "2026-05-01", toExclusive: "2026-06-01" });
  });
  it("parses a quarter (current contains today)", () => {
    expect(parsePeriod("2026-Q2", NOW)).toMatchObject({
      granularity: "quarter", anchor: "2026-Q2",
      from: "2026-04-01", toExclusive: "2026-07-01", label: "Q2 2026", isCurrent: true,
    });
  });
  it("parses a year", () => {
    expect(parsePeriod("2026", NOW)).toMatchObject({
      granularity: "year", from: "2026-01-01", toExclusive: "2027-01-01", label: "2026", isCurrent: true,
    });
  });
  it("falls back to the current month on missing/garbage input", () => {
    expect(parsePeriod(undefined, NOW)).toMatchObject({ granularity: "month", anchor: "2026-06" });
    expect(parsePeriod("not-a-period", NOW)).toMatchObject({ granularity: "month", anchor: "2026-06" });
  });
});

describe("currentPeriod", () => {
  it("returns the to-date period for each granularity", () => {
    expect(currentPeriod("quarter", NOW).anchor).toBe("2026-Q2");
    expect(currentPeriod("year", NOW).anchor).toBe("2026");
  });
});

describe("stepPeriod", () => {
  it("steps months across the year boundary", () => {
    expect(stepPeriod(parsePeriod("2026-01", NOW), -1, NOW).anchor).toBe("2025-12");
  });
  it("steps quarters across the year boundary", () => {
    expect(stepPeriod(parsePeriod("2026-Q1", NOW), -1, NOW).anchor).toBe("2025-Q4");
  });
  it("steps years", () => {
    expect(stepPeriod(parsePeriod("2026", NOW), -1, NOW).anchor).toBe("2025");
  });
});

describe("enumerateBuckets", () => {
  it("month -> one daily bucket per day", () => {
    const b = enumerateBuckets(parsePeriod("2026-06", NOW));
    expect(b).toHaveLength(30);
    expect(b[0]).toMatchObject({ key: "2026-06-01", label: "1" });
    expect(b[29].key).toBe("2026-06-30");
  });
  it("quarter -> 7-day buckets clipped to the period end", () => {
    const b = enumerateBuckets(parsePeriod("2026-Q2", NOW)); // Apr1..Jun30 = 91 days
    expect(b).toHaveLength(13);
    expect(b[0]).toMatchObject({ key: "2026-04-01", label: "Apr 1" });
    expect(b[12].toExclusive).toBe("2026-07-01"); // last bucket clipped
  });
  it("year -> 12 monthly buckets", () => {
    const b = enumerateBuckets(parsePeriod("2026", NOW));
    expect(b).toHaveLength(12);
    expect(b[0]).toMatchObject({ key: "2026-01", label: "Jan" });
    expect(b[11]).toMatchObject({ key: "2026-12", label: "Dec" });
  });
});

describe("stepping bounds", () => {
  it("canStepForward is false only for the current period", () => {
    expect(canStepForward(parsePeriod("2026-06", NOW))).toBe(false);
    expect(canStepForward(parsePeriod("2026-05", NOW))).toBe(true);
  });
  it("canStepBack stops at the earliest month with data", () => {
    expect(canStepBack(parsePeriod("2025-08", NOW), "2025-08")).toBe(false);
    expect(canStepBack(parsePeriod("2025-09", NOW), "2025-08")).toBe(true);
  });
});
