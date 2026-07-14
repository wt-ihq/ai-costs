import { describe, expect, it } from "vitest";
import { computeRecurringFacts, monthsBetween, pickColorSlot, type RecurringEntry } from "./recurring";

const THROUGH = "2026-07-01";
const entry = (over: Partial<RecurringEntry>): RecurringEntry => ({
  tool: "Perplexity", department: "Data Science", kind: "monthly",
  amount: 40, fxRate: 1, startMonth: "2026-05-01", endMonth: null, ...over,
});
const totalCents = (facts: { costUsd: number }[]) => Math.round(facts.reduce((s, f) => s + f.costUsd * 100, 0));

describe("monthsBetween", () => {
  it("is inclusive and rolls years", () => {
    expect(monthsBetween("2026-11-01", "2027-02-01")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
  });
});

describe("computeRecurringFacts", () => {
  it("monthly: one seat fact per month from start through the current month", () => {
    const facts = computeRecurringFacts([entry({})], THROUGH);
    expect(facts.map((f) => f.day)).toEqual(["2026-05-01", "2026-06-01", "2026-07-01"]);
    expect(facts[0]).toMatchObject({
      source: "other", costType: "seat", costUsd: 40,
      entityKey: "perplexity|Data Science", model: "Perplexity",
      department: "Data Science", employeeId: null,
    });
  });

  it("monthly: clips at end_month; £ converts once", () => {
    const facts = computeRecurringFacts([entry({ amount: 40, fxRate: 1.27, endMonth: "2026-06-01" })], THROUGH);
    expect(facts.map((f) => f.day)).toEqual(["2026-05-01", "2026-06-01"]);
    expect(facts[0].costUsd).toBe(50.8); // round(40 × 1.27, 2)
  });

  it("contract: cent-exact even split, last month absorbs the remainder", () => {
    // €1000 at 1.17 = $1170.00 across 7 months: 6 × $167.14 + $167.16
    const facts = computeRecurringFacts(
      [entry({ kind: "contract", amount: 1000, fxRate: 1.17, startMonth: "2026-01-01", endMonth: "2026-07-01" })],
      THROUGH,
    );
    expect(facts).toHaveLength(7);
    expect(facts.slice(0, 6).every((f) => f.costUsd === 167.14)).toBe(true);
    expect(facts[6].costUsd).toBe(167.16);
    expect(totalCents(facts)).toBe(117000);
  });

  it("contract: future months beyond throughMonth are not materialized yet (remainder month included only when reached)", () => {
    const facts = computeRecurringFacts(
      [entry({ kind: "contract", amount: 1200, fxRate: 1, startMonth: "2026-06-01", endMonth: "2027-05-01" })],
      THROUGH,
    );
    expect(facts.map((f) => f.day)).toEqual(["2026-06-01", "2026-07-01"]); // 2 of 12 months so far
    expect(facts.every((f) => f.costUsd === 100)).toBe(true);
  });

  it("aggregates multiple entries for one (tool, month, department) into one fact", () => {
    const facts = computeRecurringFacts(
      [entry({ amount: 40 }), entry({ amount: 10, startMonth: "2026-07-01" })],
      THROUGH,
    );
    const july = facts.find((f) => f.day === "2026-07-01");
    expect(july?.costUsd).toBe(50);
    expect(facts.filter((f) => f.day === "2026-07-01")).toHaveLength(1);
  });

  it("keeps distinct departments as distinct facts (collision-free keys)", () => {
    const facts = computeRecurringFacts(
      [entry({ startMonth: "2026-07-01" }), entry({ startMonth: "2026-07-01", department: null })],
      THROUGH,
    );
    expect(facts.map((f) => f.entityKey).sort()).toEqual(["perplexity", "perplexity|Data Science"]);
    expect(facts.find((f) => f.entityKey === "perplexity")?.department).toBeNull();
  });

  it("ignores entries starting after throughMonth", () => {
    expect(computeRecurringFacts([entry({ startMonth: "2026-08-01" })], THROUGH)).toEqual([]);
  });
});

describe("pickColorSlot", () => {
  const t = (tool: string, colorSlot: number) => ({ tool, colorSlot });
  it("reuses the existing slot for a known tool (case-insensitive)", () => {
    expect(pickColorSlot([t("Perplexity", 3)], "perplexity")).toBe(3);
  });
  it("assigns the lowest free slot to a new tool", () => {
    expect(pickColorSlot([t("A", 0), t("B", 2)], "C")).toBe(1);
  });
  it("reuses the least-used slot when all 8 are taken", () => {
    const existing = [0, 1, 2, 3, 4, 5, 6, 7, 0].map((s, i) => t(`T${i}`, s)); // slot 0 used twice
    expect(pickColorSlot(existing, "New")).toBe(1); // lowest among the least-used (1..7 used once)
  });
});
