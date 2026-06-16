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
});
