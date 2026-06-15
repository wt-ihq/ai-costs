import { describe, expect, it } from "vitest";
import { buildSeatFacts } from "./seats";

const prices = {
  "claude_team:premium": 30,
  "claude_team:standard": 30,
  "claude_team:unassigned": 0,
};

describe("buildSeatFacts", () => {
  it("prices seats per tier and keys to the 1st of the month", () => {
    const facts = buildSeatFacts(
      [
        { vendor: "claude_team", email: "a@intenthq.com", seatType: "premium" },
        { vendor: "claude_team", email: "b@intenthq.com", seatType: "unassigned" },
      ],
      prices,
      "2026-06-15",
    );
    expect(facts).toHaveLength(2);
    expect(facts[0]).toEqual({
      source: "claude_team",
      day: "2026-06-01",
      costType: "seat",
      entityKey: "a@intenthq.com",
      costUsd: 30,
    });
    expect(facts[1].costUsd).toBe(0); // unassigned still emitted at $0
  });

  it("defaults to 0 for an unknown tier rather than dropping the seat", () => {
    const facts = buildSeatFacts(
      [{ vendor: "claude_team", email: "c@intenthq.com", seatType: "mystery" }],
      prices,
      "2026-06-01",
    );
    expect(facts[0].costUsd).toBe(0);
  });
});
