import { describe, expect, it } from "vitest";
import { computeSeatFacts, UNASSIGNED_SEATS_KEY } from "./seat-months";
import { computeClaudeSeatFacts, CLAUDE_UNASSIGNED_KEY } from "./seat-months";

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

  it("entry with MORE members than seats: remainder placement is deterministic by entityKey, not input order", () => {
    // 2 seats × $25 = $50.00 over 3 members: floor(5000/3)=1666 -> alpha/bravo 16.66, charlie (last alphabetically) 16.68.
    const memberSet = [
      { entityKey: "charlie", employeeId: null },
      { entityKey: "alpha", employeeId: null },
      { entityKey: "bravo", employeeId: null },
    ];
    const forward = computeSeatFacts(MONTH, { seats: 2, priceUsd: 25 }, memberSet, 25);
    const reversed = computeSeatFacts(MONTH, { seats: 2, priceUsd: 25 }, [...memberSet].reverse(), 25);

    const toMap = (facts: { entityKey: string; costUsd: number }[]) =>
      Object.fromEntries(facts.map((f) => [f.entityKey, f.costUsd]));

    expect(toMap(forward)).toEqual({ alpha: 16.66, bravo: 16.66, charlie: 16.68 });
    expect(toMap(reversed)).toEqual(toMap(forward));
  });

  it("entry priced per month overrides the default", () => {
    const facts = computeSeatFacts(MONTH, { seats: 2, priceUsd: 20 }, members(2), 25);
    expect(facts.every((f) => f.costUsd === 20)).toBe(true);
  });

  it("zero-total entry with no members yields no facts (caller removes any stale unassigned fact)", () => {
    expect(computeSeatFacts(MONTH, { seats: 0, priceUsd: 25 }, [], 25)).toEqual([]);
  });
});

describe("computeSeatFacts with source/unassignedKey opts", () => {
  it("stamps the given source and unassigned key", () => {
    const facts = computeSeatFacts(MONTH, { seats: 2, priceUsd: 19.05 }, [], 19.05, {
      source: "claude_team",
      unassignedKey: CLAUDE_UNASSIGNED_KEY.standard,
    });
    expect(facts).toEqual([
      expect.objectContaining({ source: "claude_team", entityKey: "unassigned seats (standard)", costUsd: 38.1 }),
    ]);
  });

  it("defaults remain ChatGPT (regression)", () => {
    const facts = computeSeatFacts(MONTH, { seats: 1, priceUsd: 25 }, [], 25);
    expect(facts[0]).toMatchObject({ source: "chatgpt_business", entityKey: "unassigned seats" });
  });
});

describe("computeClaudeSeatFacts", () => {
  const std = [{ entityKey: "a@x.com", employeeId: "e1" }, { entityKey: "b@x.com", employeeId: null }];
  const prem = [{ entityKey: "c@x.com", employeeId: "e3" }];

  it("computes per tier with distinct unassigned keys, cent-exact per tier", () => {
    const facts = computeClaudeSeatFacts(MONTH, [
      { seatType: "standard", entry: { seats: 3, priceUsd: 19.05 }, members: std, defaultPriceUsd: 19.05 },
      { seatType: "premium", entry: { seats: 2, priceUsd: 95.25 }, members: prem, defaultPriceUsd: 95.25 },
    ]);
    // standard: 2 members at 19.05 + remainder (3-2)×19.05; premium: 1 member + 1 unassigned
    expect(facts.filter((f) => f.source === "claude_team")).toHaveLength(facts.length);
    expect(facts.find((f) => f.entityKey === CLAUDE_UNASSIGNED_KEY.standard)?.costUsd).toBe(19.05);
    expect(facts.find((f) => f.entityKey === CLAUDE_UNASSIGNED_KEY.premium)?.costUsd).toBe(95.25);
    const total = Math.round(facts.reduce((s, f) => s + f.costUsd * 100, 0));
    expect(total).toBe(Math.round((3 * 19.05 + 2 * 95.25) * 100)); // 5715 + 19050
  });

  it("no entries: each tier's members at that tier's default price", () => {
    const facts = computeClaudeSeatFacts(MONTH, [
      { seatType: "standard", entry: null, members: std, defaultPriceUsd: 19.05 },
      { seatType: "premium", entry: null, members: prem, defaultPriceUsd: 95.25 },
    ]);
    expect(facts.find((f) => f.entityKey === "a@x.com")?.costUsd).toBe(19.05);
    expect(facts.find((f) => f.entityKey === "c@x.com")?.costUsd).toBe(95.25);
    expect(facts.filter((f) => f.entityKey.startsWith("unassigned seats"))).toHaveLength(0);
  });

  it("returns [] only when every tier yields [] (zero totals, no members)", () => {
    expect(computeClaudeSeatFacts(MONTH, [
      { seatType: "standard", entry: { seats: 0, priceUsd: 19.05 }, members: [], defaultPriceUsd: 19.05 },
      { seatType: "premium", entry: null, members: [], defaultPriceUsd: 95.25 },
    ])).toEqual([]);
  });
});
