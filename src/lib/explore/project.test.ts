import { describe, expect, it } from "vitest";
import { projectPeriodEnd, projectTrend, projectTrendForPeriod, type ProjectionPeriod } from "./project";
import type { ShapeFact } from "./shape";

const NOW = new Date("2026-07-15T12:00:00Z"); // July: 31 days; cutoff = Jul 13; window = 13 days

const MONTH: ProjectionPeriod = { granularity: "month", from: "2026-07-01", toExclusive: "2026-08-01", label: "July 2026" };
const QUARTER: ProjectionPeriod = { granularity: "quarter", from: "2026-07-01", toExclusive: "2026-10-01", label: "Q3 2026" };
const YEAR: ProjectionPeriod = { granularity: "year", from: "2026-01-01", toExclusive: "2027-01-01", label: "2026" };
const ALL: ProjectionPeriod = { granularity: "all", from: "2025-01-01", toExclusive: "2026-07-16", label: "All time" };

const fact = (day: string, costType: ShapeFact["costType"], costUsd: number): ShapeFact => ({
  day, costType, costUsd,
  source: "anthropic", employeeId: null, department: null, fullName: null, entityKey: "k", model: "",
});

// $10/day of usage across the 13-day run-rate window (Jul 1–13)
const julyUsage = () =>
  Array.from({ length: 13 }, (_, i) => fact(`2026-07-${String(i + 1).padStart(2, "0")}`, "metered", 10));

describe("projectPeriodEnd — month", () => {
  it("fixed costs are known, only usage extrapolates from the lag-adjusted run rate", () => {
    const facts = [
      fact("2026-07-01", "seat", 1000),          // fixed: never extrapolated
      fact("2026-07-01", "subscription", 500),   // fixed
      ...julyUsage(),
    ];
    const p = projectPeriodEnd(facts, NOW, MONTH)!;
    expect(p.label).toBe("July");
    expect(p.compareLabel).toBe("last month");
    expect(p.basis).toBe("run-rate");
    // fixed 1500 + window 130 + rate 10 × remaining 18 days (Jul 14–31) = 1810
    expect(p.projectedUsd).toBe(1810);
  });

  it("naive extrapolation would overshoot — seats posted on the 1st stay flat", () => {
    const facts = [fact("2026-07-01", "seat", 3100)];
    const p = projectPeriodEnd(facts, NOW, MONTH)!;
    expect(p.projectedUsd).toBe(3100); // NOT 3100 × (31/15)
  });

  it("compares against last month's actual total", () => {
    const facts = [
      fact("2026-06-10", "metered", 800),
      fact("2026-06-01", "seat", 200), // last month total 1000
      ...julyUsage(),
    ];
    const p = projectPeriodEnd(facts, NOW, MONTH)!;
    expect(p.prevPeriodUsd).toBe(1000);
    // projected = 130 + 10×18 = 310 → (310-1000)/1000
    expect(p.deltaPct).toBeCloseTo(-69);
  });

  it("falls back to the previous month's rate early in the month", () => {
    const early = new Date("2026-07-02T12:00:00Z"); // cutoff Jun 30 → window 0 days
    const facts = [
      ...Array.from({ length: 30 }, (_, i) => fact(`2026-06-${String(i + 1).padStart(2, "0")}`, "metered", 30)), // $30/day June
      fact("2026-07-01", "seat", 100),
    ];
    const p = projectPeriodEnd(facts, early, MONTH)!;
    expect(p.basis).toBe("previous-month");
    // fixed 100 + rate 30 × 31 remaining days (whole July still ahead of cutoff)
    expect(p.projectedUsd).toBe(100 + 30 * 31);
  });

  it("never projects below what has actually posted", () => {
    // A burst on the lag days (after the rate window) must not be projected away.
    const facts = [
      ...Array.from({ length: 13 }, (_, i) => fact(`2026-07-${String(i + 1).padStart(2, "0")}`, "metered", 1)),
      fact("2026-07-14", "metered", 5000), // inside the 2-day lag exclusion
    ];
    const p = projectPeriodEnd(facts, NOW, MONTH)!;
    expect(p.projectedUsd).toBeGreaterThanOrEqual(5013);
  });

  it("returns null when there is nothing to project", () => {
    expect(projectPeriodEnd([], NOW, MONTH)).toBeNull();
    expect(projectPeriodEnd([fact("2026-01-01", "seat", 10)], NOW, MONTH)).toBeNull(); // no current/prev month data
  });
});

describe("projectPeriodEnd — quarter", () => {
  it("projects to quarter end: current month + future months at fixed level + run rate", () => {
    const facts = [
      fact("2026-07-01", "seat", 1000),
      fact("2026-07-01", "subscription", 500),
      ...julyUsage(),
    ];
    const p = projectPeriodEnd(facts, NOW, QUARTER)!;
    expect(p.label).toBe("Q3 26"); // year shortened so the tile header fits one line
    expect(p.compareLabel).toBe("last quarter");
    // July 1810 + Aug (1500 fixed + 10×31) + Sep (1500 fixed + 10×30) = 1810 + 1810 + 1800
    expect(p.projectedUsd).toBe(5420);
  });

  it("counts months already elapsed in the quarter as actuals", () => {
    const aug = new Date("2026-08-15T12:00:00Z"); // mid-Q3: July is complete
    const facts = [
      fact("2026-07-05", "metered", 700),  // July actual
      fact("2026-08-01", "seat", 100),
      ...Array.from({ length: 13 }, (_, i) => fact(`2026-08-${String(i + 1).padStart(2, "0")}`, "metered", 10)),
    ];
    const p = projectPeriodEnd(facts, aug, QUARTER)!;
    // July actual 700 + Aug (100 + 130 + 10×18) + Sep (100 fixed + 10×30) = 700 + 410 + 400
    expect(p.projectedUsd).toBe(1510);
  });

  it("compares against the previous quarter's actual total", () => {
    const facts = [
      fact("2026-04-10", "metered", 300), // Q2
      fact("2026-06-10", "metered", 200), // Q2 → 500 total
      ...julyUsage(),
    ];
    const p = projectPeriodEnd(facts, NOW, QUARTER)!;
    expect(p.prevPeriodUsd).toBe(500);
  });
});

describe("projectPeriodEnd — year and all time", () => {
  it("projects to year end and compares against last year", () => {
    const facts = [
      fact("2025-06-10", "metered", 1200), // last year total
      fact("2026-03-10", "metered", 950),  // elapsed 2026 actual
      ...julyUsage(),
    ];
    const p = projectPeriodEnd(facts, NOW, YEAR)!;
    expect(p.label).toBe("2026");
    expect(p.compareLabel).toBe("last year");
    expect(p.prevPeriodUsd).toBe(1200);
    // 950 past + July (130 + 10×18) + Aug…Dec at 10/day (31+30+31+30+31 = 153 days)
    expect(p.projectedUsd).toBe(950 + 310 + 10 * 153);
  });

  it("all time collapses to the current-month projection", () => {
    const facts = [fact("2026-07-01", "seat", 100), ...julyUsage()];
    const p = projectPeriodEnd(facts, NOW, ALL)!;
    expect(p.label).toBe("July");
    expect(p.compareLabel).toBe("last month");
    expect(p.projectedUsd).toBe(100 + 130 + 10 * 18);
  });
});

// Variable: Apr 100, May 200, Jun 300 (slope +100/mo); July fixed = 50.
const linearFacts = () => [
  fact("2026-04-10", "metered", 100),
  fact("2026-05-10", "metered", 200),
  fact("2026-06-10", "metered", 300),
  fact("2026-07-01", "subscription", 50),
];

describe("projectTrend", () => {
  it("fits the variable trend over complete months and adds the fixed level", () => {
    const t = projectTrend(linearFacts(), NOW, 3);
    expect(t.map((p) => p.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    // Aug = 5th point on the line (idx 4): 100 + 100×4 = 500; +fixed 50
    expect(t.map((p) => p.projected)).toEqual([550, 650, 750]);
  });

  it("clamps a downward fit at zero (plus fixed)", () => {
    const facts = [
      fact("2026-05-10", "metered", 200),
      fact("2026-06-10", "metered", 50), // slope -150/mo → goes negative fast
    ];
    const t = projectTrend(facts, NOW, 3);
    expect(t.every((p) => p.projected >= 0)).toBe(true);
  });

  it("returns [] with fewer than 2 complete months of variable data", () => {
    expect(projectTrend([fact("2026-06-10", "metered", 100)], NOW, 3)).toEqual([]);
    expect(projectTrend([], NOW, 3)).toEqual([]);
  });
});

describe("projectTrendForPeriod", () => {
  it("year view fills the remaining months of the year with bucket-matching labels", () => {
    const t = projectTrendForPeriod(linearFacts(), NOW, YEAR);
    // Labels must match the year chart's month buckets ("Aug", not "Aug 26"),
    // so the line lands in the existing slots instead of appending new ones.
    expect(t.map((p) => p.label)).toEqual(["Aug", "Sep", "Oct", "Nov", "Dec"]);
    expect(t[0].projected).toBe(550);
    expect(t[4].projected).toBe(950);
  });

  it("a past year projects nothing", () => {
    const past: ProjectionPeriod = { granularity: "year", from: "2025-01-01", toExclusive: "2026-01-01", label: "2025" };
    expect(projectTrendForPeriod(linearFacts(), NOW, past)).toEqual([]);
  });

  it("all time appends 3 months in the all-time label style", () => {
    const t = projectTrendForPeriod(linearFacts(), NOW, ALL);
    expect(t.map((p) => p.label)).toEqual(["Aug 26", "Sep 26", "Oct 26"]);
    expect(t.map((p) => p.projected)).toEqual([550, 650, 750]);
  });

  it("day/week granularities get no projection line", () => {
    expect(projectTrendForPeriod(linearFacts(), NOW, MONTH)).toEqual([]);
    expect(projectTrendForPeriod(linearFacts(), NOW, QUARTER)).toEqual([]);
  });
});
