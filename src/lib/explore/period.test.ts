import { describe, expect, it } from "vitest";
import {
  parsePeriod, currentPeriod, allTimePeriod, stepPeriod, enumerateBuckets,
  canStepForward, canStepBack, highlightBucketLabel,
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

// --- Week (ISO, Mon–Sun) and Day -------------------------------------------
// NOW is Wed 17 Jun 2026 → ISO week 2026-W25 (Mon 15 – Sun 21 Jun).

describe("week periods", () => {
  it("parses an ISO week as Mon–Sun and marks the current one", () => {
    expect(parsePeriod("2026-W25", NOW)).toMatchObject({
      granularity: "week", anchor: "2026-W25",
      from: "2026-06-15", toExclusive: "2026-06-22",
      label: "15–21 Jun 2026", isCurrent: true,
    });
  });
  it("parses a past week", () => {
    expect(parsePeriod("2026-W24", NOW)).toMatchObject({ from: "2026-06-08", label: "8–14 Jun 2026", isCurrent: false });
  });
  it("labels a week spanning two months", () => {
    // Mon 31 Aug – Sun 6 Sep 2026
    expect(parsePeriod("2026-W36", NOW).label).toBe("31 Aug – 6 Sep 2026");
  });
  it("handles W01 starting in the previous calendar year", () => {
    expect(parsePeriod("2026-W01", NOW)).toMatchObject({
      from: "2025-12-29", toExclusive: "2026-01-05", label: "29 Dec 2025 – 4 Jan 2026",
    });
  });
  it("handles a 53-week ISO year", () => {
    expect(parsePeriod("2026-W53", NOW)).toMatchObject({ from: "2026-12-28", toExclusive: "2027-01-04" });
  });
  it("steps by whole weeks across the year boundary", () => {
    expect(stepPeriod(parsePeriod("2026-W01", NOW), -1, NOW).anchor).toBe("2025-W52");
    expect(stepPeriod(parsePeriod("2026-W25", NOW), -1, NOW).anchor).toBe("2026-W24");
  });
  it("enumerates 7 daily buckets", () => {
    const b = enumerateBuckets(parsePeriod("2026-W25", NOW));
    expect(b).toHaveLength(7);
    expect(b[0]).toMatchObject({ key: "2026-06-15", label: "Mon 15", from: "2026-06-15", toExclusive: "2026-06-16" });
    expect(b[6]).toMatchObject({ key: "2026-06-21", label: "Sun 21" });
  });
  it("currentPeriod returns this week", () => {
    expect(currentPeriod("week", NOW).anchor).toBe("2026-W25");
  });
});

describe("day periods", () => {
  it("parses a day and marks today", () => {
    expect(parsePeriod("2026-06-17", NOW)).toMatchObject({
      granularity: "day", anchor: "2026-06-17",
      from: "2026-06-17", toExclusive: "2026-06-18",
      label: "17 Jun 2026", isCurrent: true,
    });
  });
  it("parses a past day", () => {
    expect(parsePeriod("2026-06-16", NOW)).toMatchObject({ label: "16 Jun 2026", isCurrent: false });
  });
  it("rejects an impossible date and falls back", () => {
    expect(parsePeriod("2026-13-40", NOW)).toMatchObject({ granularity: "month", anchor: "2026-06" });
    expect(parsePeriod("2026-02-30", NOW)).toMatchObject({ granularity: "month", anchor: "2026-06" });
  });
  it("steps by one day across a month boundary", () => {
    expect(stepPeriod(parsePeriod("2026-06-01", NOW), -1, NOW).anchor).toBe("2026-05-31");
    expect(stepPeriod(parsePeriod("2026-05-31", NOW), 1, NOW).anchor).toBe("2026-06-01");
  });
  it("enumerates the trailing 14 days, selected day last", () => {
    const b = enumerateBuckets(parsePeriod("2026-06-17", NOW));
    expect(b).toHaveLength(14);
    expect(b[13]).toMatchObject({ key: "2026-06-17", label: "17 Jun", toExclusive: "2026-06-18" });
    expect(b[0].key).toBe("2026-06-04");
  });
  it("currentPeriod returns today", () => {
    expect(currentPeriod("day", NOW).anchor).toBe("2026-06-17");
  });
});

describe("stepping bounds at day precision", () => {
  it("lets a day step back inside the earliest month", () => {
    expect(canStepBack(parsePeriod("2025-08-05", NOW), "2025-08")).toBe(true);
    expect(canStepBack(parsePeriod("2025-08-01", NOW), "2025-08")).toBe(false);
  });
  it("still stops months at the earliest month", () => {
    expect(canStepBack(parsePeriod("2025-08", NOW), "2025-08")).toBe(false);
  });
});

describe("highlightBucketLabel", () => {
  it("names the selected day's bucket, and nothing for other granularities", () => {
    expect(highlightBucketLabel(parsePeriod("2026-06-17", NOW))).toBe("17 Jun");
    expect(highlightBucketLabel(parsePeriod("2026-W25", NOW))).toBeUndefined();
    expect(highlightBucketLabel(parsePeriod("2026-06", NOW))).toBeUndefined();
  });
});
