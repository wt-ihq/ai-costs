import { describe, expect, it } from "vitest";
import { normalizeAnthropic } from "./anthropic";
import { normalizeOpenAI } from "./openai";
import { anthropicCostFixture } from "@/lib/ingest/fixtures/anthropic-cost";
import { openaiCostFixture } from "@/lib/ingest/fixtures/openai-cost";
import { SchemaDriftError } from "@/lib/ingest/types";

describe("normalizeAnthropic", () => {
  it("maps cost rows to metered facts keyed by api key id", () => {
    const facts = normalizeAnthropic(anthropicCostFixture);
    expect(facts).toHaveLength(3);
    expect(facts[0]).toMatchObject({
      source: "anthropic",
      costType: "metered",
      entityKey: "ak_prod_ingest",
      costUsd: 412.5,
      model: "claude-opus-4-8",
      tokens: 8_900_000,
    });
  });
  it("throws on schema drift", () => {
    expect(() => normalizeAnthropic({} as never)).toThrow(SchemaDriftError);
  });
});

describe("normalizeOpenAI", () => {
  it("maps cost rows to metered facts keyed by project id", () => {
    const facts = normalizeOpenAI(openaiCostFixture);
    expect(facts).toHaveLength(3);
    expect(facts[0]).toMatchObject({
      source: "openai",
      costType: "metered",
      entityKey: "proj_search",
      costUsd: 233.4,
      model: "gpt-5",
    });
  });
  it("throws on schema drift", () => {
    expect(() => normalizeOpenAI({ data: "nope" } as never)).toThrow(SchemaDriftError);
  });
});
