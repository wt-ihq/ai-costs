import { describe, expect, it } from "vitest";
import { buildOpenRouterData, type OpenRouterScope } from "./shape";
import { parsePeriod } from "@/lib/explore/period";

const NOW = new Date("2026-07-20T12:00:00Z");
const JULY = parsePeriod("2026-07", NOW);

const scope: OpenRouterScope = {
  rows: [
    { day: "2026-07-01", entityKey: "gareth.jones@intenthq.com", model: "anthropic/claude-sonnet-4-6", costUsd: 12.5, tokens: 250000, requests: 40, personName: "Gareth Jones" },
    { day: "2026-07-01", entityKey: "gareth.jones@intenthq.com", model: "openai/gpt-5.2", costUsd: 2.25, tokens: 50000, requests: 10, personName: "Gareth Jones" },
    { day: "2026-07-02", entityKey: "contractor@external.dev", model: "anthropic/claude-sonnet-4-6", costUsd: 3, tokens: 60000, requests: 12, personName: null },
    { day: "2026-07-02", entityKey: "unkeyed", model: "", costUsd: 0.6, tokens: 0, requests: 0, personName: null },
    { day: "2026-06-30", entityKey: "gareth.jones@intenthq.com", model: "openai/gpt-5.2", costUsd: 99, tokens: 1, requests: 1, personName: "Gareth Jones" }, // outside July
  ],
  earliest: "2026-06",
};

describe("buildOpenRouterData", () => {
  it("aggregates totals, people, and models within the period only", () => {
    const data = buildOpenRouterData(scope, JULY);
    expect(data.total).toBeCloseTo(18.35, 5);
    expect(data.tokens).toBe(360000);
    expect(data.requests).toBe(62);
    expect(data.people).toBe(2); // unkeyed doesn't count as a member
    expect(data.modelCount).toBe(3); // sonnet, gpt, "(no model)"
    expect(data.topModel).toBe("anthropic/claude-sonnet-4-6");
  });

  it("ranks models and people by spend, keeping unmatched emails visible", () => {
    const data = buildOpenRouterData(scope, JULY);
    expect(data.byModel[0]).toMatchObject({ model: "anthropic/claude-sonnet-4-6", cost: 15.5, tokens: 310000 });
    expect(data.byPerson.map((p) => p.name)).toEqual([
      "Gareth Jones",
      "contractor@external.dev", // unmatched → shown as the raw email
      "Unattributed", // the unkeyed bucket
    ]);
  });

  it("builds a stacked daily spend trend over the month's buckets", () => {
    const data = buildOpenRouterData(scope, JULY);
    expect(data.trend).toHaveLength(31);
    expect(data.trend[0]).toMatchObject({ label: "1", "anthropic/claude-sonnet-4-6": 12.5, "openai/gpt-5.2": 2.25 });
    expect(data.trend[1]).toMatchObject({ label: "2", "anthropic/claude-sonnet-4-6": 3, "(no model)": 0.6 });
    expect(data.trend[2]).toEqual({ label: "3" }); // empty day carries no series keys
  });

  it("returns an empty shape for a period with no rows", () => {
    const data = buildOpenRouterData(scope, parsePeriod("2026-05", NOW));
    expect(data.total).toBe(0);
    expect(data.byModel).toEqual([]);
    expect(data.byPerson).toEqual([]);
    expect(data.topModel).toBeNull();
  });
});
