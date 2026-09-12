import { describe, expect, it } from "vitest";
import { buildTrends } from "./trends";
import { parsePeriod, allTimePeriod } from "./period";
import type { RawScope } from "./build";
import type { ShapeFact } from "./shape";

const NOW = new Date("2026-09-11T10:00:00Z");

function fact(day: string, costUsd: number, over: Partial<ShapeFact> = {}): ShapeFact {
  return {
    day, costUsd,
    source: "anthropic", costType: "metered", employeeId: "a", department: "Eng", fullName: "Alice", entityKey: "k-a", model: "opus",
    ...over,
  };
}

const bob = { employeeId: "b", department: "Sales", fullName: "Bob", entityKey: "k-b" } as const;
const carol = { employeeId: "c", department: "Eng", fullName: "Carol", entityKey: "k-c" } as const;

function companyScope(facts: ShapeFact[]): RawScope {
  return {
    kind: "company", title: "Company", earliest: "2026-06", facts,
    headcounts: { Eng: 2, Sales: 1 },
    employees: [
      { id: "a", fullName: "Alice", department: "Eng" },
      { id: "b", fullName: "Bob", department: "Sales" },
      { id: "c", fullName: "Carol", department: "Eng" },
    ],
    toolColors: {}, horizons: {},
  };
}

function teamScope(facts: ShapeFact[]): RawScope {
  return {
    kind: "team", title: "Eng", earliest: "2026-06", facts, team: "Eng",
    employees: [{ id: "a", fullName: "Alice" }, { id: "c", fullName: "Carol" }],
    toolColors: {}, horizons: {},
  };
}

describe("buildTrends", () => {
  it("returns null on the All time period (nothing to compare against)", () => {
    const scope = companyScope([fact("2026-07-03", 10)]);
    expect(buildTrends(scope, allTimePeriod("2026-06", NOW), NOW)).toBeNull();
  });

  it("compares a complete month against the previous month", () => {
    const scope = companyScope([
      fact("2026-07-05", 100), // July: Eng 100
      fact("2026-08-05", 150), // Aug: Eng 150
      fact("2026-08-06", 50, bob), // Aug: Sales 50
    ]);
    const t = buildTrends(scope, parsePeriod("2026-08", NOW), NOW)!;
    expect(t.priorLabel).toBe("July 2026");
    expect(t.truncatedDays).toBeNull();
    expect(t).toMatchObject({ current: 200, prior: 100, delta: 100, pct: 100 });
  });

  it("ranks movers at the page grain with the ranked list's ids and hrefs", () => {
    const scope = companyScope([
      fact("2026-07-05", 100), // Eng: 100 → 150 (+50)
      fact("2026-08-05", 150),
      fact("2026-07-06", 80, bob), // Sales: 80 → 20 (−60)
      fact("2026-08-06", 20, bob),
    ]);
    const t = buildTrends(scope, parsePeriod("2026-08", NOW), NOW)!;
    expect(t.risers).toHaveLength(1);
    expect(t.risers[0]).toMatchObject({ id: "Eng", label: "Eng", href: "/explore/Eng", prior: 100, current: 150, delta: 50, pct: 50 });
    expect(t.fallers).toHaveLength(1);
    expect(t.fallers[0]).toMatchObject({ id: "Sales", prior: 80, current: 20, delta: -60, pct: -75 });
  });

  it("orders risers and fallers by absolute dollar change, capped at five each", () => {
    const facts: ShapeFact[] = [];
    for (let i = 0; i < 7; i++) {
      const dept = `D${i}`;
      const who = { employeeId: `e${i}`, department: dept, fullName: `P${i}`, entityKey: `k${i}` };
      facts.push(fact("2026-07-05", 10, who));
      facts.push(fact("2026-08-05", 10 + (i + 1) * 5, who)); // deltas 5,10,…,35
    }
    const t = buildTrends(companyScope(facts), parsePeriod("2026-08", NOW), NOW)!;
    expect(t.risers.map((r) => r.delta)).toEqual([35, 30, 25, 20, 15]);
    expect(t.fallers).toHaveLength(0);
  });

  it("splits entities that only spent in one period into new spenders and gone quiet", () => {
    const scope = companyScope([
      fact("2026-07-05", 100), // Eng both months
      fact("2026-08-05", 100),
      fact("2026-08-06", 30, bob), // Sales: new in Aug
      fact("2026-07-06", 45, { ...carol, department: "Ops" }), // Ops: quiet in Aug
    ]);
    const t = buildTrends(scope, parsePeriod("2026-08", NOW), NOW)!;
    expect(t.newSpenders.map((m) => m.id)).toEqual(["Sales"]);
    expect(t.newSpenders[0]).toMatchObject({ prior: 0, current: 30, pct: null });
    expect(t.goneQuiet.map((m) => m.id)).toEqual(["Ops"]);
    expect(t.goneQuiet[0]).toMatchObject({ prior: 45, current: 0, pct: -100 });
    expect(t.risers).toHaveLength(0);
    expect(t.fallers).toHaveLength(0);
  });

  it("hides movers where both periods are under the dollar floor", () => {
    const scope = companyScope([
      fact("2026-07-05", 0.2),
      fact("2026-08-05", 0.6),
      fact("2026-08-06", 0.3, bob),
    ]);
    const t = buildTrends(scope, parsePeriod("2026-08", NOW), NOW)!;
    expect(t.risers).toHaveLength(0);
    expect(t.newSpenders).toHaveLength(0);
  });

  it("compares an in-progress month like-for-like over the elapsed days, excluding monthly-level facts", () => {
    const scope = companyScope([
      // Aug 1–10 metered: 10/day = 100; Aug 20 metered: 500 (outside the elapsed window)
      ...Array.from({ length: 10 }, (_, i) => fact(`2026-08-${String(i + 1).padStart(2, "0")}`, 10)),
      fact("2026-08-20", 500),
      // Sep 1–10 metered: 15/day = 150
      ...Array.from({ length: 10 }, (_, i) => fact(`2026-09-${String(i + 1).padStart(2, "0")}`, 15)),
      // Seats stamped to the 1st of each month — excluded from a partial comparison
      fact("2026-08-01", 400, { source: "cursor", costType: "seat", model: "" }),
      fact("2026-09-01", 400, { source: "cursor", costType: "seat", model: "" }),
    ]);
    const t = buildTrends(scope, parsePeriod("2026-09", NOW), NOW)!;
    expect(t.truncatedDays).toBe(10); // 1–10 Sep have landed; today (the 11th) has not
    expect(t.priorLabel).toBe("August 2026");
    expect(t).toMatchObject({ current: 150, prior: 100, delta: 50, pct: 50 });
  });

  it("does not truncate a completed period even when it is the current one", () => {
    const scope = companyScope([fact("2026-09-10", 10), fact("2026-09-09", 5)]);
    // The Day view: 10 Sep is complete (today is the 11th).
    const t = buildTrends(scope, parsePeriod("2026-09-10", NOW), NOW)!;
    expect(t.truncatedDays).toBeNull();
    expect(t).toMatchObject({ current: 10, prior: 5 });
  });

  it("lists notable days: variable spend over twice the period median, naming the top driver", () => {
    const facts: ShapeFact[] = [];
    for (let d = 1; d <= 20; d++) facts.push(fact(`2026-08-${String(d).padStart(2, "0")}`, 10));
    facts.push(fact("2026-08-21", 90, bob)); // 100 total that day → 10× the median
    facts.push(fact("2026-08-21", 10));
    facts.push(fact("2026-08-01", 400, { source: "cursor", costType: "seat", model: "" })); // fixed: ignored
    const t = buildTrends(companyScope(facts), parsePeriod("2026-08", NOW), NOW)!;
    expect(t.notableDays).toHaveLength(1);
    expect(t.notableDays[0]).toMatchObject({ day: "2026-08-21", total: 100, median: 10, driver: "Sales" });
  });

  it("only computes notable days at month grain and above", () => {
    const facts: ShapeFact[] = [];
    for (let d = 3; d <= 8; d++) facts.push(fact(`2026-08-${String(d).padStart(2, "0")}`, 1));
    facts.push(fact("2026-08-09", 200));
    const week = buildTrends(companyScope(facts), parsePeriod("2026-W32", NOW), NOW)!;
    expect(week.notableDays).toEqual([]);
  });

  it("names people on a team page and flags estimated Anthropic allocation", () => {
    const scope = teamScope([
      fact("2026-07-05", 100),
      fact("2026-08-05", 160),
      fact("2026-08-06", 20, carol),
    ]);
    const t = buildTrends(scope, parsePeriod("2026-08", NOW), NOW)!;
    expect(t.risers[0]).toMatchObject({ id: "a", label: "Alice", href: "/explore/Eng/a", delta: 60 });
    expect(t.newSpenders[0]).toMatchObject({ id: "c", label: "Carol" });
    expect(t.hasEstimatedAllocation).toBe(true);
  });

  it("does not flag estimated allocation when no Anthropic spend is involved", () => {
    const scope = teamScope([
      fact("2026-07-05", 100, { source: "cursor", costType: "overage" }),
      fact("2026-08-05", 160, { source: "cursor", costType: "overage" }),
    ]);
    const t = buildTrends(scope, parsePeriod("2026-08", NOW), NOW)!;
    expect(t.hasEstimatedAllocation).toBe(false);
  });
});
