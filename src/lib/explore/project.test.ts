import { describe, expect, it } from "vitest";
import { projectPeriodEnd, projectTrend, projectTrendForPeriod, type ProjectionPeriod } from "./project";
import type { ShapeFact } from "./shape";

const NOW = new Date("2026-07-15T12:00:00Z"); // July: 31 days; cutoff = Jul 13; window = 13 days

const MONTH: ProjectionPeriod = { granularity: "month", from: "2026-07-01", toExclusive: "2026-08-01", label: "July 2026" };
const QUARTER: ProjectionPeriod = { granularity: "quarter", from: "2026-07-01", toExclusive: "2026-10-01", label: "Q3 2026" };
const YEAR: ProjectionPeriod = { granularity: "year", from: "2026-01-01", toExclusive: "2027-01-01", label: "2026" };
const ALL: ProjectionPeriod = { granularity: "all", from: "2025-01-01", toExclusive: "2026-07-16", label: "All time" };

const fact = (day: string, costType: ShapeFact["costType"], costUsd: number, source: ShapeFact["source"] = "anthropic"): ShapeFact => ({
  day, costType, costUsd,
  source, employeeId: null, department: null, fullName: null, entityKey: "k", model: "",
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
      fact("2026-06-10", "metered", 300), // June daily rate 300/30 = 10 — same as July's pace, so the blend is a no-op
      fact("2026-06-01", "seat", 700),    // last month total 1000
      ...julyUsage(),
    ];
    const p = projectPeriodEnd(facts, NOW, MONTH)!;
    expect(p.prevPeriodUsd).toBe(1000);
    // projected = 130 + 10×18 = 310 → (310-1000)/1000
    expect(p.deltaPct).toBeCloseTo(-69);
  });

  it("a source's rate window ends at its own last data day, not at now", () => {
    // Manual import (credits CSV) last covered Jul 10: $30/day for 10 days.
    // Dividing by the 13 elapsed window days would understate the rate.
    const facts = Array.from({ length: 10 }, (_, i) =>
      fact(`2026-07-${String(i + 1).padStart(2, "0")}`, "overage", 30, "chatgpt_business"));
    const p = projectPeriodEnd(facts, NOW, MONTH)!;
    // rate 30/day × remaining 21 days after the 10-day window
    expect(p.projectedUsd).toBe(300 + 30 * 21);
  });

  it("sources with different data horizons each get their own rate", () => {
    const facts = [
      // cursor live through Jul 13 (the global cutoff): $20/day
      ...Array.from({ length: 13 }, (_, i) => fact(`2026-07-${String(i + 1).padStart(2, "0")}`, "overage", 20, "cursor")),
      // credits imported through Jul 10 only: $30/day
      ...Array.from({ length: 10 }, (_, i) => fact(`2026-07-${String(i + 1).padStart(2, "0")}`, "overage", 30, "chatgpt_business")),
    ];
    const t = projectTrend(facts, NOW, 1);
    // Aug = 20×31 + 30×31 — the stale source is NOT diluted by empty days
    expect(t[0].projected).toBe((20 + 30) * 31);
  });

  it("blends the current pace with last month's rate, weighted by observed days", () => {
    const facts = [
      fact("2026-06-15", "metered", 300), // June: 300/30 = $10/day
      // July: $30/day, but only 10 days observed (import horizon Jul 10)
      ...Array.from({ length: 10 }, (_, i) => fact(`2026-07-${String(i + 1).padStart(2, "0")}`, "metered", 30)),
    ];
    const t = projectTrend(facts, NOW, 1);
    // shrinkage with τ=10 prior days: (300 + 10×10) / (10 + 10) = $20/day
    expect(t[0].projected).toBe(20 * 31);
  });

  it("a declining vendor projects downward via the damped trend, gently", () => {
    const facts = [
      fact("2026-04-10", "metered", 400),
      fact("2026-05-10", "metered", 200), // ratio 0.5
      fact("2026-06-10", "metered", 100), // ratio 0.5 → damped 0.75 → clamped to 0.8/month
    ];
    const t = projectTrend(facts, NOW, 2);
    const rate = 100 / 30; // no July data → previous-month rate
    expect(t[0].projected).toBeCloseTo(rate * 31 * 0.8, 1);       // Aug
    expect(t[1].projected).toBeCloseTo(rate * 30 * 0.8 ** 2, 1);  // Sep compounds, damped
  });

  it("a growing vendor's trend is clamped so it cannot run away", () => {
    const facts = [
      fact("2026-04-10", "metered", 100),
      fact("2026-05-10", "metered", 200), // ratio 2
      fact("2026-06-10", "metered", 400), // ratio 2 → damped 1.5 → clamped to 1.2/month
    ];
    const t = projectTrend(facts, NOW, 5);
    const rate = 400 / 30;
    expect(t[0].projected).toBeCloseTo(rate * 31 * 1.2, 1); // Aug
    // Dec: 1.2^5 ≈ 2.49 exceeds the 2× cumulative cap → capped
    expect(t[4].projected).toBeCloseTo(rate * 31 * 2.0, 1);
  });

  it("non-consecutive history yields no trend (ratios need adjacent months)", () => {
    const facts = [
      fact("2026-03-10", "metered", 400), // Mar then a gap
      fact("2026-06-10", "metered", 100),
    ];
    const t = projectTrend(facts, NOW, 1);
    expect(t[0].projected).toBeCloseTo((100 / 30) * 31, 1); // flat — no growth factor
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

  it("monthly-snapshot usage (Claude Team import) is a level, not a daily rate", () => {
    // The Claude spend import posts a whole month's usage as ONE overage fact
    // on the 1st. Feeding that lump into the daily run rate inflated
    // projections ~2.4× (lump ÷ 13 window days × 31 days).
    const facts = [fact("2026-07-01", "overage", 270, "claude_team"), ...julyUsage()];
    const p = projectPeriodEnd(facts, NOW, MONTH)!;
    // lump counts once (270) + daily usage 130 + 10 × 18 remaining = 580
    expect(p.projectedUsd).toBe(580);
    // ...and future months repeat the level instead of extrapolating it:
    const t = projectTrend(facts, NOW, 1);
    expect(t[0].projected).toBe(270 + 10 * 31); // Aug
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
      fact("2026-07-05", "metered", 310),  // July actual — 10/day, same as August's pace (blend is a no-op)
      fact("2026-08-01", "seat", 100),
      ...Array.from({ length: 13 }, (_, i) => fact(`2026-08-${String(i + 1).padStart(2, "0")}`, "metered", 10)),
    ];
    const p = projectPeriodEnd(facts, aug, QUARTER)!;
    // July actual 310 + Aug (100 + 130 + 10×18) + Sep (100 fixed + 10×30) = 310 + 410 + 400
    expect(p.projectedUsd).toBe(1120);
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
      fact("2025-01-05", "metered", 100),  // data span covers all of last year
      fact("2025-06-10", "metered", 1200),
      fact("2026-03-10", "metered", 950),  // elapsed 2026 actual
      ...julyUsage(),
    ];
    const p = projectPeriodEnd(facts, NOW, YEAR)!;
    expect(p.label).toBe("’26"); // year shortened so the tile header fits one line
    expect(p.compareLabel).toBe("last year");
    expect(p.prevPeriodUsd).toBe(1300);
    // 950 past + July (130 + 10×18) + Aug…Dec at 10/day (31+30+31+30+31 = 153 days)
    expect(p.projectedUsd).toBe(950 + 310 + 10 * 153);
  });

  it("suppresses the comparison when the data doesn't cover the previous period", () => {
    // Data begins March 2025: comparing 2026's projection against a partial
    // 2025 would read "+19463% vs last year" and mean nothing.
    const facts = [
      fact("2025-03-10", "metered", 40),
      fact("2026-03-10", "metered", 950),
      ...julyUsage(),
    ];
    const p = projectPeriodEnd(facts, NOW, YEAR)!;
    expect(p.prevPeriodUsd).toBeNull();
    expect(p.deltaPct).toBeNull();
  });

  it("all time collapses to the current-month projection", () => {
    const facts = [fact("2026-07-01", "seat", 100), ...julyUsage()];
    const p = projectPeriodEnd(facts, NOW, ALL)!;
    expect(p.label).toBe("July");
    expect(p.compareLabel).toBe("last month");
    expect(p.projectedUsd).toBe(100 + 130 + 10 * 18);
  });
});

// July: seat 1000 on the 1st, $10/day usage → rate 10, fixed level 1000.
const paceFacts = () => [fact("2026-07-01", "seat", 1000), ...julyUsage()];

describe("projectTrend", () => {
  it("projects future months at the current pace: fixed level + run rate × days", () => {
    const t = projectTrend(paceFacts(), NOW, 3);
    expect(t.map((p) => p.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    // Aug 31d / Sep 30d / Oct 31d at $10/day, on the $1000 fixed level
    expect(t.map((p) => p.projected)).toEqual([1310, 1300, 1310]);
  });

  it("agrees with the period-end tile: year projection = actuals + the line's months", () => {
    // The tile and the dashed line MUST tell one story — the year-end figure
    // is exactly the posted actuals plus the line's remaining months.
    const facts = [fact("2026-03-10", "metered", 950), ...paceFacts()];
    const tile = projectPeriodEnd(facts, NOW, YEAR)!;
    const line = projectTrend(facts, NOW, 5); // Aug–Dec
    const julyProjected = 1000 + 130 + 10 * 18;
    const lineSum = line.reduce((s, p) => s + p.projected, 0);
    expect(tile.projectedUsd).toBeCloseTo(950 + julyProjected + lineSum, 6);
  });

  it("returns [] when there is nothing to project", () => {
    expect(projectTrend([], NOW, 3)).toEqual([]);
    expect(projectTrend([fact("2026-01-01", "seat", 10)], NOW, 3)).toEqual([]); // no current/prev month data
  });
});

describe("projectTrendForPeriod", () => {
  it("year view anchors on the current month's actual MTD total (the bar top), then fills the rest of the year", () => {
    const t = projectTrendForPeriod(paceFacts(), NOW, YEAR);
    // The anchor equals the July bar's height exactly, so the dashed line
    // starts at the last entry's level and rises into the projection.
    // Labels must match the year chart's month buckets ("Jul", not "Jul 26").
    expect(t.map((p) => p.label)).toEqual(["Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
    expect(t[0].projected).toBe(1130); // July posted so far: 1000 + 130
    expect(t[1].projected).toBe(1310); // Aug: 1000 + 10×31
    expect(t[5].projected).toBe(1310);
  });

  it("a past year projects nothing", () => {
    const past: ProjectionPeriod = { granularity: "year", from: "2025-01-01", toExclusive: "2026-01-01", label: "2025" };
    expect(projectTrendForPeriod(paceFacts(), NOW, past)).toEqual([]);
  });

  it("all time anchors on the current month, then 3 future months, in the all-time label style", () => {
    const t = projectTrendForPeriod(paceFacts(), NOW, ALL);
    expect(t.map((p) => p.label)).toEqual(["Jul 26", "Aug 26", "Sep 26", "Oct 26"]);
    expect(t.map((p) => p.projected)).toEqual([1130, 1310, 1300, 1310]);
  });

  it("day/week granularities get no projection line", () => {
    expect(projectTrendForPeriod(paceFacts(), NOW, MONTH)).toEqual([]);
    expect(projectTrendForPeriod(paceFacts(), NOW, QUARTER)).toEqual([]);
  });
});
