import { describe, expect, it } from "vitest";
import { computeSeatFacts, UNASSIGNED_SEATS_KEY } from "./seat-months";

const MONTH = "2026-06-01";
const members = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ entityKey: `person ${i + 1}`, employeeId: i === 0 ? "e1" : null }));

const total = (facts: { costUsd: number }[]) =>
  Math.round(facts.reduce((s, f) => s + f.costUsd * 100, 0)); // cents, avoids float noise

describe("computeSeatFacts", () => {
  it("no entry: members at the default price (today's behavior), no unassigned fact", () => {
    const facts = computeSeatFacts(MONTH, null, members(3), 25);
    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.costUsd === 25 && f.costType === "seat" && f.day === MONTH)).toBe(true);
    expect(facts.find((f) => f.entityKey === UNASSIGNED_SEATS_KEY)).toBeUndefined();
    expect(facts[0].employeeId).toBe("e1"); // attribution preserved
  });

  it("entry with no members: one unassigned fact of seats × price", () => {
    const facts = computeSeatFacts(MONTH, { seats: 27, priceUsd: 25 }, [], 25);
    expect(facts).toEqual([
      expect.objectContaining({ entityKey: UNASSIGNED_SEATS_KEY, costUsd: 675, employeeId: null }),
    ]);
  });

  it("entry with fewer members than seats: members at price + unassigned remainder", () => {
    const facts = computeSeatFacts(MONTH, { seats: 23, priceUsd: 25 }, members(20), 99);
    expect(facts).toHaveLength(21);
    expect(facts.filter((f) => f.entityKey !== UNASSIGNED_SEATS_KEY).every((f) => f.costUsd === 25)).toBe(true);
    expect(facts.find((f) => f.entityKey === UNASSIGNED_SEATS_KEY)?.costUsd).toBe(75); // (23-20) × 25
    expect(total(facts)).toBe(57500); // exactly 23 × $25
  });

  it("entry with members == seats: no unassigned fact", () => {
    const facts = computeSeatFacts(MONTH, { seats: 3, priceUsd: 30 }, members(3), 25);
    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.costUsd === 30)).toBe(true);
  });

  it("entry with MORE members than seats: total split evenly, cent-exact", () => {
    // 20 seats × $25 = $500.00 over 23 members: 22 × $21.73 + 1 × $21.94
    const facts = computeSeatFacts(MONTH, { seats: 20, priceUsd: 25 }, members(23), 25);
    expect(facts).toHaveLength(23);
    expect(facts.find((f) => f.entityKey === UNASSIGNED_SEATS_KEY)).toBeUndefined();
    expect(total(facts)).toBe(50000); // exactly 20 × $25
    expect(facts.slice(0, 22).every((f) => f.costUsd === 21.73)).toBe(true);
    expect(facts[22].costUsd).toBe(21.94); // last row absorbs the rounding remainder
  });

  it("entry priced per month overrides the default", () => {
    const facts = computeSeatFacts(MONTH, { seats: 2, priceUsd: 20 }, members(2), 25);
    expect(facts.every((f) => f.costUsd === 20)).toBe(true);
  });

  it("zero-total entry with no members yields no facts (caller removes any stale unassigned fact)", () => {
    expect(computeSeatFacts(MONTH, { seats: 0, priceUsd: 25 }, [], 25)).toEqual([]);
  });
});
