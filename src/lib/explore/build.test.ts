import { describe, expect, it } from "vitest";
import { buildExploreData, type RawScope } from "./build";
import { parsePeriod, allTimePeriod } from "./period";
import type { ShapeFact } from "./shape";

const NOW = new Date("2026-06-17T12:00:00Z");
const facts: ShapeFact[] = [
  { day: "2026-05-03", source: "cursor", costType: "seat", costUsd: 40, employeeId: "a", department: "Eng", fullName: "A", entityKey: "a@x", model: "" },
  { day: "2026-06-01", source: "cursor", costType: "seat", costUsd: 40, employeeId: "a", department: "Eng", fullName: "A", entityKey: "a@x", model: "" },
  { day: "2026-06-09", source: "anthropic", costType: "metered", costUsd: 100, employeeId: "a", department: "Eng", fullName: "A", entityKey: "k1", model: "opus" },
];

const companyScope: RawScope = {
  kind: "company", title: "Company", earliest: "2026-05", facts,
  headcounts: { Eng: 2 },
  employees: [{ id: "a", fullName: "A", department: "Eng" }, { id: "z", fullName: "Z", department: "Sales" }],
  toolColors: {},
};

describe("buildExploreData", () => {
  it("scopes the scorecard/treemap/ranked to the selected period (June)", () => {
    const data = buildExploreData(companyScope, parsePeriod("2026-06", NOW));
    expect(data.scorecard).toMatchObject({ total: 140, seat: 40, metered: 100 });
    expect(data.totalToDate).toBe(180); // all facts, period-independent
    expect(data.ranked.kind).toBe("team");
    expect(data.ranked.rows[0]).toMatchObject({ id: "Eng", total: 140 });
  });

  it("re-slices instantly to a different period (May) from the SAME scope", () => {
    const data = buildExploreData(companyScope, parsePeriod("2026-05", NOW));
    expect(data.scorecard.total).toBe(40); // only the May seat fact
    expect(data.period.label).toBe("May 2026");
  });

  it("all-time view sums every fact and equals total-to-date", () => {
    const data = buildExploreData(companyScope, allTimePeriod("2026-05", NOW));
    expect(data.scorecard.total).toBe(180); // all three facts (May + June)
    expect(data.scorecard.total).toBe(data.totalToDate);
    expect(data.period.label).toBe("All time");
    expect(data.trend.vendor.length).toBeGreaterThan(0); // monthly buckets across the span
  });

  it("includes the company All-staff roster ($0 staff kept)", () => {
    const data = buildExploreData(companyScope, parsePeriod("2026-06", NOW));
    expect(data.allStaff).toBeDefined();
    expect(data.allStaff!.find((r) => r.id === "z")).toMatchObject({ total: 0, sub: "Sales" });
  });
});
