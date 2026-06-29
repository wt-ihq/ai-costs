import { describe, expect, it } from "vitest";
import { normalizeCursorModels, type CursorByUserModelsResponse } from "./cursor-models";
import { cursorModelsFixture } from "@/lib/ingest/fixtures/cursor-models";
import { SchemaDriftError } from "@/lib/ingest/types";

describe("normalizeCursorModels", () => {
  it("emits one fact per (email, day, model) with message volume", () => {
    const facts = normalizeCursorModels(cursorModelsFixture);
    // gareth: sonnet 6/1, gpt 6/1, sonnet 6/2 = 3; tom: opus 6/1 = 1;
    // contractor: gpt 6/3 = 1. The zero-message `auto` entry is dropped.
    expect(facts).toHaveLength(5);

    const garethSonnet1 = facts.find(
      (f) => f.entityKey === "gareth.jones@intenthq.com" && f.day === "2026-06-01" && f.model === "claude-sonnet-4.5",
    )!;
    expect(garethSonnet1).toMatchObject({
      day: "2026-06-01",
      entityKey: "gareth.jones@intenthq.com",
      model: "claude-sonnet-4.5",
      messages: 120,
    });
  });

  it("drops zero-message model entries", () => {
    const facts = normalizeCursorModels(cursorModelsFixture);
    expect(facts.some((f) => f.model === "auto")).toBe(false);
  });

  it("sums messages when the same (email, day, model) appears more than once", () => {
    const dup: CursorByUserModelsResponse = {
      data: {
        "gareth.jones@intenthq.com": [
          { date: "2026-06-01", model_breakdown: { "claude-sonnet-4.5": { messages: 10, users: 1 } } },
          { date: "2026-06-01", model_breakdown: { "claude-sonnet-4.5": { messages: 5, users: 1 } } },
        ],
      },
    };
    const facts = normalizeCursorModels(dup);
    expect(facts).toHaveLength(1);
    expect(facts[0].messages).toBe(15);
  });

  it("lowercases the email so identity resolution matches", () => {
    const mixed: CursorByUserModelsResponse = {
      data: { "Gareth.Jones@IntentHQ.com": [{ date: "2026-06-01", model_breakdown: { "gpt-4o": { messages: 3 } } }] },
    };
    expect(normalizeCursorModels(mixed)[0].entityKey).toBe("gareth.jones@intenthq.com");
  });

  it("fails loudly on schema drift rather than writing garbage", () => {
    expect(() => normalizeCursorModels({} as CursorByUserModelsResponse)).toThrow(SchemaDriftError);
    expect(() => normalizeCursorModels({ data: [] } as unknown as CursorByUserModelsResponse)).toThrow(SchemaDriftError);
  });
});
