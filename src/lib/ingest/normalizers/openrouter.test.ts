import { describe, expect, it } from "vitest";
import { applyActivityRemainder, normalizeOpenRouterAnalytics, type OpenRouterAnalyticsResponse } from "./openrouter";
import { openRouterActivityFixture, openRouterAnalyticsFixture } from "@/lib/ingest/fixtures/openrouter";
import { SchemaDriftError } from "@/lib/ingest/types";

const WINDOW = { startDate: "2026-07-01", endDate: "2026-08-01" };

describe("normalizeOpenRouterAnalytics", () => {
  it("maps rows to metered facts on the (day, email, model) grain with tokens/requests", () => {
    const facts = normalizeOpenRouterAnalytics(openRouterAnalyticsFixture, WINDOW);

    const sonnet = facts.find((f) => f.day === "2026-07-01" && f.model === "anthropic/claude-sonnet-4-6");
    expect(sonnet).toMatchObject({
      source: "openrouter",
      costType: "metered",
      entityKey: "gareth.jones@intenthq.com", // lowercased from Gareth.Jones@
      costUsd: 12.5,
      tokens: 250000, // parsed from the string "250000"
      requests: 40,
    });

    const gpt = facts.find((f) => f.day === "2026-07-01" && f.model === "openai/gpt-5.2");
    expect(gpt?.costUsd).toBe(2.25); // parsed from the string "2.25"
  });

  it("keeps free-model rows (0 cost, real tokens) and buckets null users as unkeyed", () => {
    const facts = normalizeOpenRouterAnalytics(openRouterAnalyticsFixture, WINDOW);

    const free = facts.find((f) => f.model === "meta-llama/llama-4-maverick:free");
    expect(free).toMatchObject({ costUsd: 0, tokens: 9000, requests: 3 });

    const unkeyed = facts.find((f) => f.entityKey === "unkeyed");
    expect(unkeyed).toMatchObject({ day: "2026-07-02", costUsd: 0.75, model: "anthropic/claude-haiku-4-5" });
  });

  it("clamps rows outside [startDate, endDate) — time_range end-inclusivity isn't trusted", () => {
    const facts = normalizeOpenRouterAnalytics(openRouterAnalyticsFixture, WINDOW);
    expect(facts.some((f) => f.day === "2026-08-01")).toBe(false);
  });

  it("aggregates rows that collapse onto the same (day, email, model) key", () => {
    const raw: OpenRouterAnalyticsResponse = {
      data: {
        data: [
          { date__day: "2026-07-01T00:00:00.000Z", user: "u1", user_email: "A@x.com", model: "m", total_usage: 1, tokens_total: 10, request_count: 1 },
          { date__day: "2026-07-01T00:00:00.000Z", user: "u1", user_email: "a@x.com", model: "m", total_usage: 2, tokens_total: 20, request_count: 3 },
        ],
      },
    };
    const facts = normalizeOpenRouterAnalytics(raw, WINDOW);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ entityKey: "a@x.com", costUsd: 3, tokens: 30, requests: 4 });
  });

  it("throws SchemaDriftError on a missing data array, missing day bucket, or non-numeric metric", () => {
    expect(() => normalizeOpenRouterAnalytics({} as OpenRouterAnalyticsResponse, WINDOW)).toThrow(SchemaDriftError);
    expect(() =>
      normalizeOpenRouterAnalytics({ data: { data: [{ user_email: "a@x.com", total_usage: 1 }] } }, WINDOW),
    ).toThrow(SchemaDriftError);
    expect(() =>
      normalizeOpenRouterAnalytics(
        { data: { data: [{ date__day: "2026-07-01T00:00:00.000Z", user_email: "a@x.com", total_usage: "n/a" }] } },
        WINDOW,
      ),
    ).toThrow(SchemaDriftError);
  });
});

describe("applyActivityRemainder", () => {
  it("tops up a day where /activity reports more than the analytics rows sum to (BYOK excluded)", () => {
    const facts = normalizeOpenRouterAnalytics(openRouterAnalyticsFixture, WINDOW);
    const healed = applyActivityRemainder(facts, openRouterActivityFixture, WINDOW);

    // 2026-07-01 agrees (14.75 both sides) — no new fact.
    expect(healed.filter((f) => f.day === "2026-07-01")).toHaveLength(2);

    // 2026-07-02: activity 4.35 (byok 1.23 NOT counted) vs analytics 3.75 → 0.60 remainder.
    const remainder = healed.find((f) => f.day === "2026-07-02" && f.entityKey === "unkeyed" && f.model === "");
    expect(remainder?.costUsd).toBeCloseTo(0.6, 5);
  });

  it("merges the remainder into an existing unkeyed/model-less fact instead of duplicating its conflict key", () => {
    const facts = [
      { source: "openrouter" as const, day: "2026-07-02", costType: "metered" as const, entityKey: "unkeyed", costUsd: 1, model: "" },
    ];
    const healed = applyActivityRemainder(facts, { data: [{ date: "2026-07-02", usage: 3 }] }, WINDOW);
    expect(healed).toHaveLength(1);
    expect(healed[0].costUsd).toBe(3);
  });

  it("ignores negative drift and days outside the window", () => {
    const facts = [
      { source: "openrouter" as const, day: "2026-07-02", costType: "metered" as const, entityKey: "a@x.com", costUsd: 5, model: "m" },
    ];
    const healed = applyActivityRemainder(
      facts,
      { data: [{ date: "2026-07-02", usage: 4 }, { date: "2026-06-15", usage: 100 }] },
      WINDOW,
    );
    expect(healed).toEqual(facts);
  });

  it("creates an unkeyed fact for an activity day the analytics rows missed entirely", () => {
    const healed = applyActivityRemainder([], { data: [{ date: "2026-07-05", usage: 2.5 }] }, WINDOW);
    expect(healed).toEqual([
      { source: "openrouter", day: "2026-07-05", costType: "metered", entityKey: "unkeyed", costUsd: 2.5, model: "" },
    ]);
  });
});
