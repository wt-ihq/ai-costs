import { describe, expect, it } from "vitest";
import { personMonthUsage, weeksOf, workingDaysIn } from "./shape";
import type { CursorUsageDay, PersonCursorUsageScope } from "./types";

const row = (day: string, o: Partial<CursorUsageDay> = {}): CursorUsageDay => ({
  day, employeeId: "e1", entityKey: "a@b.c", isActive: true, agentRequests: 100, includedReqs: 100, onDemandReqs: 0,
  linesAdded: 20, linesDeleted: 10, acceptedLinesAdded: 15, acceptedLinesDeleted: 12, mostUsedModel: "sonnet", ...o,
});

const scope: PersonCursorUsageScope = {
  rows: [
    row("2026-10-01"),
    row("2026-10-02"),
    row("2026-10-05", { linesAdded: 30, acceptedLinesAdded: 20, acceptedLinesDeleted: 16, onDemandReqs: 10, includedReqs: 90 }),
  ],
  facts: [
    { day: "2026-10-01", employeeId: "e1", costType: "seat", costUsd: 40 },
    { day: "2026-10-05", employeeId: "e1", costType: "overage", costUsd: 20 },
  ],
  months: ["2026-10"],
};

describe("cursor usage shapers", () => {
  it("counts working days", () => { expect(workingDaysIn("2026-10")).toBe(22); });
  it("lists the Mondays of every week touching the month", () => {
    expect(weeksOf("2026-10")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  });
  it("shapes a month: tiles and weeks", () => {
    const usage = personMonthUsage(scope, "2026-10")!;
    expect(usage.tiles).toMatchObject({ activeDays: 3, workingDays: 22, agentRequests: 300, linesKept: 90, linesSuggested: 100, keptShare: 0.9, seatUsd: 40, onDemandUsd: 20, onDemandFrom: "2026-10-05", mostUsedModel: "sonnet" });
    expect(usage.weeks).toHaveLength(5);
    expect(usage.weeks[1]).toMatchObject({ monday: "2026-10-05", requests: 100, onDemandUsd: 20 });
    expect(usage.weeks[0].days[0]).toMatchObject({ day: "2026-09-28", inMonth: false });
    expect(usage.weeks[0].days[3]).toMatchObject({ day: "2026-10-01", inMonth: true, active: true, agentRequests: 100 });
  });
  it("returns null for a month without rows", () => { expect(personMonthUsage(scope, "2026-08")).toBeNull(); });
});
