import { describe, expect, it } from "vitest";
import { buildOpenRouterData, type OpenRouterScope } from "./shape";
import { parsePeriod } from "@/lib/explore/period";

const NOW = new Date("2026-07-20T12:00:00Z");
const JULY = parsePeriod("2026-07", NOW);

const scope: OpenRouterScope = {
  rows: [
    { day: "2026-07-01", costType: "metered" as const, entityKey: "gareth.jones@intenthq.com", model: "anthropic/claude-sonnet-4-6", costUsd: 12.5, tokens: 250000, requests: 40, personName: "Gareth Jones" },
    { day: "2026-07-01", costType: "metered" as const, entityKey: "gareth.jones@intenthq.com", model: "openai/gpt-5.2", costUsd: 2.25, tokens: 50000, requests: 10, personName: "Gareth Jones" },
    { day: "2026-07-02", costType: "metered" as const, entityKey: "contractor@external.dev", model: "anthropic/claude-sonnet-4-6", costUsd: 3, tokens: 60000, requests: 12, personName: null },
    { day: "2026-07-02", costType: "metered" as const, entityKey: "unkeyed", model: "", costUsd: 0.6, tokens: 0, requests: 0, personName: null },
    { day: "2026-06-30", costType: "metered" as const, entityKey: "gareth.jones@intenthq.com", model: "openai/gpt-5.2", costUsd: 99, tokens: 1, requests: 1, personName: "Gareth Jones" }, // outside July
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
    ]);
    expect(data.byWorkspace.map((p) => p.name)).toEqual(["Unattributed"]); // the unkeyed bucket
  });

  it("builds a daily spend trend over the FULL month, like the Explore trend", () => {
    const data = buildOpenRouterData(scope, JULY);
    expect(data.trend).toHaveLength(31); // empty days keep their axis slot
    expect(data.trend[0]).toEqual({ label: "1", metered: 14.75, subscription: 0 });
    expect(data.trend[1]).toEqual({ label: "2", metered: 3.6, subscription: 0 });
    expect(data.trend[2]).toEqual({ label: "3", metered: 0, subscription: 0 });
  });

  it("amortizes the month-stamped subscription across the month's days, usage stays on its day", () => {
    const subScope: OpenRouterScope = {
      rows: [
        { day: "2026-07-01", costType: "subscription" as const, entityKey: "openrouter|AI Operations", model: "OpenRouter", costUsd: 1550, tokens: 0, requests: 0, personName: null },
        { day: "2026-07-02", costType: "metered" as const, entityKey: "a@x.com", model: "m", costUsd: 10, tokens: 5, requests: 1, personName: "A" },
      ],
      earliest: "2026-07",
    };
    const data = buildOpenRouterData(subScope, JULY);
    expect(data.total).toBe(1560);
    expect(data.usage).toBe(10);
    expect(data.subscription).toBe(1550);
    // 1550 / 31 days = $50/day base on EVERY day; usage only on the 2nd.
    expect(data.trend[0]).toEqual({ label: "1", metered: 0, subscription: 50 });
    expect(data.trend[1]).toEqual({ label: "2", metered: 10, subscription: 50 });
    expect(data.trend[30]).toEqual({ label: "31", metered: 0, subscription: 50 });
    // The fee never pollutes the usage lists.
    expect(data.byModel.some((m) => m.model === "OpenRouter")).toBe(false);
    expect(data.byWorkspace.some((w) => w.name === "openrouter|AI Operations")).toBe(false);
    expect(data.tokens).toBe(5);
  });

  it("year view enumerates all 12 months, subscription as a lump in its month", () => {
    const yearScope: OpenRouterScope = {
      rows: [
        { day: "2026-07-01", costType: "metered" as const, entityKey: "a@x.com", model: "m", costUsd: 5, tokens: 0, requests: 0, personName: "A" },
        { day: "2026-09-15", costType: "metered" as const, entityKey: "a@x.com", model: "m", costUsd: 7, tokens: 0, requests: 0, personName: "A" },
        { day: "2026-09-01", costType: "subscription" as const, entityKey: "openrouter|AI Operations", model: "OpenRouter", costUsd: 1500, tokens: 0, requests: 0, personName: null },
      ],
      earliest: "2026-07",
    };
    const data = buildOpenRouterData(yearScope, parsePeriod("2026", new Date("2026-10-20T12:00:00Z")));
    expect(data.trend).toHaveLength(12);
    expect(data.trend.find((p) => p.label === "Jul")).toEqual({ label: "Jul", metered: 5, subscription: 0 });
    expect(data.trend.find((p) => p.label === "Sep")).toEqual({ label: "Sep", metered: 7, subscription: 1500 });
    expect(data.trend.find((p) => p.label === "Aug")).toEqual({ label: "Aug", metered: 0, subscription: 0 });
  });

  it("merges permaslug date snapshots into one display model", () => {
    const snapScope: OpenRouterScope = {
      rows: [
        { day: "2026-07-01", costType: "metered" as const, entityKey: "a@x.com", model: "anthropic/claude-opus-5-20260723", costUsd: 5, tokens: 10, requests: 1, personName: "A" },
        { day: "2026-07-02", costType: "metered" as const, entityKey: "a@x.com", model: "anthropic/claude-opus-5-20260528", costUsd: 7, tokens: 20, requests: 2, personName: "A" },
      ],
      earliest: "2026-07",
    };
    const data = buildOpenRouterData(snapScope, JULY);
    expect(data.byModel).toHaveLength(1);
    expect(data.byModel[0]).toMatchObject({ model: "anthropic/claude-opus-5", cost: 12, tokens: 30 });
    expect(data.topModel).toBe("anthropic/claude-opus-5");
  });

  it("splits people from workspace-keyed usage, each with a per-entity model split", () => {
    const wsScope: OpenRouterScope = {
      rows: [
        { day: "2026-07-01", costType: "metered" as const, entityKey: "gareth.jones@intenthq.com", model: "anthropic/claude-sonnet-5", costUsd: 8, tokens: 100, requests: 4, personName: "Gareth Jones" },
        { day: "2026-07-02", costType: "metered" as const, entityKey: "gareth.jones@intenthq.com", model: "openai/gpt-5.6-sol", costUsd: 2, tokens: 20, requests: 1, personName: "Gareth Jones" },
        { day: "2026-07-02", costType: "metered" as const, entityKey: "AI Operations", model: "moonshotai/kimi-k3", costUsd: 5, tokens: 50, requests: 2, personName: null },
      ],
      earliest: "2026-07",
    };
    const data = buildOpenRouterData(wsScope, JULY);

    const gareth = data.byPerson.find((p) => p.name === "Gareth Jones");
    expect(gareth?.kind).toBe("member");
    expect(gareth?.models).toEqual([
      { model: "anthropic/claude-sonnet-5", cost: 8 },
      { model: "openai/gpt-5.6-sol", cost: 2 },
    ]);

    expect(data.byPerson.some((p) => p.name === "AI Operations")).toBe(false); // not mixed in with people
    const ws = data.byWorkspace.find((p) => p.name === "AI Operations");
    expect(ws?.kind).toBe("workspace");
    expect(ws?.models).toEqual([{ model: "moonshotai/kimi-k3", cost: 5 }]);

    expect(data.people).toBe(1); // workspace entities don't count as members
  });

  it("returns an empty shape for a period with no rows", () => {
    const data = buildOpenRouterData(scope, parsePeriod("2026-05", NOW));
    expect(data.total).toBe(0);
    expect(data.byModel).toEqual([]);
    expect(data.byPerson).toEqual([]);
    expect(data.byWorkspace).toEqual([]);
    expect(data.topModel).toBeNull();
    expect(data.trend.every((p) => p.metered === 0 && p.subscription === 0)).toBe(true);
  });
});
