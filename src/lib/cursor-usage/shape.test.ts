import { describe, expect, it } from "vitest";
import { aggregateTeamMonths, personMonthUsage, teamMonthUsage, weeksOf, workingDaysIn } from "./shape";
import type { CursorFactLite, CursorUsageDay, PersonCursorUsageScope, TeamCursorUsageScope } from "./types";

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

describe("teamMonthUsage", () => {
  const days = (id: string, n: number) =>
    Array.from({ length: n }, (_, i) => row(`2026-10-${String(i + 1).padStart(2, "0")}`, { employeeId: id }));
  const person = (id: string, name: string) => ({ employeeId: id, name, department: "Eng", href: `/explore/Eng/${id}` });
  const rows = [...days("a", 20), ...days("b", 1), row("2026-10-03", { employeeId: "c", isActive: false, agentRequests: 0, includedReqs: 0 })];
  const facts: CursorFactLite[] = [
    ...["a", "b", "c"].map((id) => ({ day: "2026-10-01", employeeId: id, costType: "seat" as const, costUsd: 40 })),
    { day: "2026-10-05", employeeId: "a", costType: "overage" as const, costUsd: 100 },
  ];
  const people = [person("a", "Ann"), person("b", "Bob"), person("c", "Cy"), person("d", "Dee"), person("f", "Fay")];
  const team: TeamCursorUsageScope = { months: aggregateTeamMonths(rows, facts), people };

  it("shapes tiles and both lists", () => {
    const u = teamMonthUsage(team, "2026-10")!;
    expect(u.tiles).toMatchObject({ peopleActive: 2, seats: 3, unusedSeats: 1, medianActiveDays: 1, workingDays: 22 });
    expect(u.tiles).toMatchObject({ agentRequests: 2100, includedReqs: 2100, onDemandReqs: 0, linesKept: 27 * 22, keptShare: 0.9 }); // 22 rows (Cy's too)
    expect(u.mostActive[0]).toMatchObject({ name: "Ann", agentRequests: 2000, onDemandUsd: 100, href: "/explore/Eng/a" });
    expect(u.mostActive.map((p) => p.name)).toEqual(["Ann", "Bob", "Cy"]);
    expect(u.littleUse.map((p) => p.activeDays)).toEqual([0, 1]);
    expect(u.littleUse[0]).toMatchObject({ name: "Cy", seatUsd: 40 });
    expect(u.littleUseMore).toBe(0);
    expect(u.unusedSeatsUsd).toBe(40);
  });
  it("returns null for a month without rows", () => { expect(teamMonthUsage(team, "2026-08")).toBeNull(); });

  it("aggregates one entry per (person, month), ordered by first usage row, facts-only people after", () => {
    const months = aggregateTeamMonths(
      [row("2026-09-30", { employeeId: "b" }), row("2026-10-02", { employeeId: "b", isActive: false }), row("2026-10-01", { employeeId: "a" }), row("2026-10-03", { employeeId: null })],
      [
        { day: "2026-10-01", employeeId: "d", costType: "seat", costUsd: 40 },
        { day: "2026-10-01", employeeId: "b", costType: "seat", costUsd: 0 },
        { day: "2026-10-04", employeeId: "b", costType: "overage", costUsd: 12.5 },
        { day: "2026-10-05", employeeId: "b", costType: "overage", costUsd: 7.5 },
        { day: "2026-10-05", employeeId: null, costType: "overage", costUsd: 99 },
      ],
    );
    expect(months.map((m) => `${m.month}|${m.employeeId}`)).toEqual(["2026-09|b", "2026-10|b", "2026-10|a", "2026-10|null", "2026-10|d"]);
    expect(months[1]).toEqual({
      month: "2026-10", employeeId: "b", usageDays: 1, activeDays: 0, agentRequests: 100, includedReqs: 100, onDemandReqs: 0,
      linesKept: 27, linesSuggested: 30, hasSeat: true, seatUsd: 0, onDemandUsd: 20,
    });
    expect(months[4]).toMatchObject({ employeeId: "d", usageDays: 0, hasSeat: true, seatUsd: 40 });
  });

  it("counts unmatched usage rows in the totals, a $0 seat as a seat, and ignores a facts-only month", () => {
    const scope: TeamCursorUsageScope = {
      months: aggregateTeamMonths(
        [row("2026-10-01", { employeeId: "a" }), row("2026-10-01", { employeeId: null, agentRequests: 50, includedReqs: 50 })],
        [
          { day: "2026-10-01", employeeId: "f", costType: "seat", costUsd: 0 }, // Free seat, never used
          { day: "2026-11-01", employeeId: "a", costType: "seat", costUsd: 40 }, // November: no usage rows yet
        ],
      ),
      people,
    };
    const u = teamMonthUsage(scope, "2026-10")!;
    expect(u.tiles).toMatchObject({ peopleActive: 1, seats: 1, unusedSeats: 1, agentRequests: 150, includedReqs: 150, linesKept: 54, medianActiveDays: 0 });
    expect(u.mostActive.map((p) => p.employeeId)).toEqual(["a"]); // the unmatched rows are nobody's
    expect(u.littleUse).toEqual([{ employeeId: "f", name: "Fay", href: "/explore/Eng/f", activeDays: 0, seatUsd: 0 }]);
    expect(u.unusedSeatsUsd).toBe(0);
    expect(teamMonthUsage(scope, "2026-11")).toBeNull();
  });

  it("caches small: one entry per person-month, however many days", () => {
    const many = Array.from({ length: 50 }, (_, p) => Array.from({ length: 30 }, (_, d) => row(`2026-10-${String(d + 1).padStart(2, "0")}`, { employeeId: `p${p}` }))).flat();
    expect(aggregateTeamMonths(many, [])).toHaveLength(50);
  });
});
