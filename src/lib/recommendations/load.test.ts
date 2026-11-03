import { describe, expect, it } from "vitest";
import { gateByRoster, isRosterStale, latestTierByEmployee, recommendTool, withoutCursorActivity, type RecommendationsData } from "./load";
import type { RecToolInput } from "./rule";

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
  it("two tiers in the same month resolve the same whatever order the rows arrive in", () => {
    const same = [
      { employeeId: "d", seatType: "standard", periodStart: "2026-10-01" },
      { employeeId: "d", seatType: "premium", periodStart: "2026-10-01" },
    ];
    expect(latestTierByEmployee(same, "2026-10-01").get("d")).toBe("premium");
    expect(latestTierByEmployee([...same].reverse(), "2026-10-01").get("d")).toBe("premium");
  });
});

// Window Mon 5 Oct – Sun 1 Nov; "big" spent $300 extra, well over any step up.
const input = (stepUpUsd: number): RecToolInput => ({
  tool: "cursor",
  stepUpUsd,
  candidates: [
    { employeeId: "big", name: "Big Spender", department: "Eng", tier: "standard", leaveDate: null },
    { employeeId: "small", name: "Small Spender", department: "Eng", tier: "standard", leaveDate: null },
    { employeeId: "prem", name: "Already Premium", department: "Eng", tier: "premium", leaveDate: null },
  ],
  spend: [
    { employeeId: "big", day: "2026-10-28", costUsd: 300 },
    { employeeId: "small", day: "2026-10-28", costUsd: 5 },
  ],
});

describe("recommendTool", () => {
  it("runs the rule when Premium is dearer and a roster exists", () => {
    const r = recommendTool(input(80), "2026-11-01", true);
    expect(r).toMatchObject({ tool: "cursor", stepUpUsd: 80, premiumCount: 1, totalSavingUsd: 220, noRoster: false, pricesMissing: false });
    expect(r.rows.map((x) => x.employeeId)).toEqual(["big"]);
  });

  it("a step up of zero or less is prices missing, not everyone flagged", () => {
    for (const stepUp of [0, -40]) {
      const r = recommendTool(input(stepUp), "2026-11-01", true);
      expect(r).toEqual({ tool: "cursor", stepUpUsd: stepUp, rows: [], premiumCount: 0, totalSavingUsd: 0, noRoster: false, pricesMissing: true });
    }
  });

  it("no roster lists nobody and counts nothing", () => {
    const r = recommendTool(input(80), "2026-11-01", false);
    expect(r).toEqual({ tool: "cursor", stepUpUsd: 80, rows: [], premiumCount: 0, totalSavingUsd: 0, noRoster: true, pricesMissing: false });
  });
});

describe("gateByRoster", () => {
  it("passes a result through when the tool has a roster", () => {
    const r = recommendTool(input(80), "2026-11-01", true);
    expect(gateByRoster(r, true)).toBe(r);
    expect(gateByRoster(r, false)).toMatchObject({ rows: [], premiumCount: 0, totalSavingUsd: 0, noRoster: true });
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

describe("withoutCursorActivity (what a viewer gets)", () => {
  it("keeps every amount and drops the requests and active days", () => {
    const usage = [{ employeeId: "big", day: "2026-10-28", agentRequests: 900, isActive: true }];
    const cursor = recommendTool({ ...input(80), usage }, "2026-11-01", true);
    expect(cursor.rows[0].weeks[3]).toMatchObject({ extraUsd: 300, requests: 900, activeDays: 1 });
    const data: RecommendationsData = {
      sunday: "2026-11-01", weeks: [], tools: [cursor], readiness: { ready: true, outstanding: [] }, rosterAsOf: { cursor: "2026-11-02" },
      cursorRosterStale: false, departments: ["Eng"], updatedAt: "2026-11-02T09:00:00Z",
    };
    const viewer = withoutCursorActivity(data);
    const cells = viewer.tools[0].rows[0].weeks;
    expect(cells.map((c) => c.extraUsd)).toEqual([0, 0, 0, 300]);
    expect(cells.every((c) => c.requests === null && c.activeDays === null)).toBe(true);
    expect(viewer.tools[0]).toMatchObject({ totalSavingUsd: 220, stepUpUsd: 80 });
    expect(data.tools[0].rows[0].weeks[3].requests).toBe(900); // the cached object is not mutated
  });
});
