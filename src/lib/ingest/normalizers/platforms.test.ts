import { describe, expect, it } from "vitest";
import { normalizeAnthropic } from "./anthropic";
import { normalizeOpenAI } from "./openai";
import { anthropicCostFixture } from "@/lib/ingest/fixtures/anthropic-cost";
import { openaiCostFixture } from "@/lib/ingest/fixtures/openai-cost";
import { SchemaDriftError } from "@/lib/ingest/types";

describe("normalizeAnthropic", () => {
  it("flattens bucket results to metered facts, parsing string amounts; skips zero", () => {
    const facts = normalizeAnthropic(anthropicCostFixture);
    expect(facts).toHaveLength(1); // the £0 workspace is skipped
    expect(facts[0]).toMatchObject({
      source: "anthropic",
      day: "2026-06-09",
      costType: "metered",
      entityKey: "wrkspc_prod",
      model: "claude-opus-4-8",
    });
    expect(facts[0].costUsd).toBeCloseTo(3265.7, 1);
  });
  it("throws on schema drift", () => {
    expect(() => normalizeAnthropic({} as never)).toThrow(SchemaDriftError);
  });
});

describe("normalizeOpenAI", () => {
  it("flattens bucket results to metered facts keyed by project id; skips zero", () => {
    const facts = normalizeOpenAI(openaiCostFixture);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      source: "openai",
      day: "2026-06-09",
      costType: "metered",
      entityKey: "proj_iBVGlnR1msrsCUrmy5RARv3V",
    });
    expect(facts[0].costUsd).toBeCloseTo(75.38, 2);
  });
  it("throws on schema drift", () => {
    expect(() => normalizeOpenAI({ data: "nope" } as never)).toThrow(SchemaDriftError);
  });
  it("falls back to unix start_time and skips undatable buckets (no empty day)", () => {
    const facts = normalizeOpenAI({
      data: [
        { start_time: 1780963200, results: [{ amount: { value: "5" }, project_id: "p1" }] }, // 2026-06-09
        { results: [{ amount: { value: "9" }, project_id: "p2" }] }, // no date -> skipped
      ],
    } as never);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ day: "2026-06-09", entityKey: "p1" });
  });
});
