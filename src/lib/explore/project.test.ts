import { describe, expect, it } from "vitest";
import { projectMonthEnd, projectTrend } from "./project";
import type { ShapeFact } from "./shape";

const NOW = new Date("2026-07-15T12:00:00Z"); // July: 31 days; cutoff = Jul 13; window = 13 days

const fact = (day: string, costType: ShapeFact["costType"], costUsd: number): ShapeFact => ({
  day, costType, costUsd,
  source: "anthropic", employeeId: null, department: null, fullName: null, entityKey: "k", model: "",
});

describe("projectMonthEnd", () => {
  it("fixed costs are known, only usage extrapolates from the lag-adjusted run rate", () => {
    const facts = [
      fact("2026-07-01", "seat", 1000),          // fixed: never extrapolated
      fact("2026-07-01", "subscription", 500),   // fixed
      // $10/day of usage across the 13-day window (Jul 1–13)
      ...Array.from({ length: 13 }, (_, i) => fact(`2026-07-${String(i + 1).padStart(2, "0")}`, "metered", 10)),
    ];
    const p = projectMonthEnd(facts, NOW)!;
    expect(p.month).toBe("2026-07");
    expect(p.basis).toBe("run-rate");
    expect(p.fixedUsd).toBe(1500);
    expect(p.variableMtdUsd).toBe(130);
    // fixed 1500 + window 130 + rate 10 × remaining 18 days (Jul 14–31) = 1810
    expect(p.projectedUsd).toBe(1810);
  });

  it("naive extrapolation would overshoot — seats posted on the 1st stay flat", () => {
    const facts = [fact("2026-07-01", "seat", 3100)];
    const p = projectMonthEnd(facts, NOW)!;
    expect(p.projectedUsd).toBe(3100); // NOT 3100 × (31/15)
  });

  it("compares against last month's actual total", () => {
    const facts = [
      fact("2026-06-10", "metered", 800),
      fact("2026-06-01", "seat", 200), // last month total 1000
      ...Array.from({ length: 13 }, (_, i) => fact(`2026-07-${String(i + 1).padStart(2, "0")}`, "metered", 10)),
    ];
    const p = projectMonthEnd(facts, NOW)!;
    expect(p.lastMonthUsd).toBe(1000);
    // projected = 130 + 10×18 = 310 → (310-1000)/1000
    expect(p.deltaPct).toBeCloseTo(-69);
  });

  it("falls back to the previous month's rate early in the month", () => {
    const early = new Date("2026-07-02T12:00:00Z"); // cutoff Jun 30 → window 0 days
    const facts = [
      ...Array.from({ length: 30 }, (_, i) => fact(`2026-06-${String(i + 1).padStart(2, "0")}`, "metered", 30)), // $30/day June
      fact("2026-07-01", "seat", 100),
    ];
    const p = projectMonthEnd(facts, early)!;
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
    const p = projectMonthEnd(facts, NOW)!;
    expect(p.projectedUsd).toBeGreaterThanOrEqual(p.fixedUsd + p.variableMtdUsd);
  });

  it("returns null when there is nothing to project", () => {
    expect(projectMonthEnd([], NOW)).toBeNull();
    expect(projectMonthEnd([fact("2026-01-01", "seat", 10)], NOW)).toBeNull(); // no current/prev month data
  });
});

describe("projectTrend", () => {
  it("fits the variable trend over complete months and adds the fixed level", () => {
    // Variable: Apr 100, May 200, Jun 300 (slope +100/mo); July fixed = 50.
    const facts = [
      fact("2026-04-10", "metered", 100),
      fact("2026-05-10", "metered", 200),
      fact("2026-06-10", "metered", 300),
      fact("2026-07-01", "subscription", 50),
    ];
    const t = projectTrend(facts, NOW, 3);
    expect(t).toHaveLength(3);
    expect(t.map((p) => p.label)).toEqual(["Aug 26", "Sep 26", "Oct 26"]);
    // Aug = 5th point on the line (idx 4): 100 + 100×4 = 500; +fixed 50
    expect(t[0].projected).toBe(550);
    expect(t[1].projected).toBe(650);
    expect(t[2].projected).toBe(750);
  });

  it("clamps a downward fit at zero (plus fixed)", () => {
    const facts = [
      fact("2026-05-10", "metered", 200),
      fact("2026-06-10", "metered", 50), // slope -150/mo → goes negative fast
    ];
    const t = projectTrend(facts, NOW, 3);
    expect(t.every((p) => (p.projected as number) >= 0)).toBe(true);
  });

  it("returns [] with fewer than 2 complete months of variable data", () => {
    expect(projectTrend([fact("2026-06-10", "metered", 100)], NOW, 3)).toEqual([]);
    expect(projectTrend([], NOW, 3)).toEqual([]);
  });
});
