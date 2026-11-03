import { describe, expect, it } from "vitest";
import { isRosterStale, latestTierByEmployee } from "./load";

describe("latestTierByEmployee", () => {
  const rows = [
    { employeeId: "a", seatType: "premium", periodStart: "2026-09-01" },
    { employeeId: "a", seatType: "standard", periodStart: "2026-11-01" },
    { employeeId: "b", seatType: "weird", periodStart: "2026-01-01" },
    { employeeId: "c", seatType: "free", periodStart: "2026-02-01" },
  ];
  it("takes the latest row at or before the month", () => {
    expect(latestTierByEmployee(rows, "2026-10-01").get("a")).toBe("premium");
    expect(latestTierByEmployee(rows, "2026-11-01").get("a")).toBe("standard");
  });
  it("leaves out someone whose only rows are after the month", () => {
    expect(latestTierByEmployee(rows, "2026-08-01").has("a")).toBe(false);
  });
  it("maps unknown tier strings to standard and keeps known ones", () => {
    const m = latestTierByEmployee(rows, "2026-10-01");
    expect(m.get("b")).toBe("standard");
    expect(m.get("c")).toBe("free");
  });
});

describe("isRosterStale", () => {
  it("is stale when over 35 days old or missing", () => {
    expect(isRosterStale("2026-09-20", "2026-11-01")).toBe(true);
    expect(isRosterStale(undefined, "2026-11-01")).toBe(true);
  });
  it("is fresh within 35 days", () => {
    expect(isRosterStale("2026-10-10", "2026-11-01")).toBe(false);
  });
});
