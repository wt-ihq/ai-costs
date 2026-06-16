import { describe, expect, it } from "vitest";
import { normalizeCursor, type CursorUsageResponse } from "./cursor";
import { cursorUsageFixture } from "@/lib/ingest/fixtures/cursor-usage";
import { SchemaDriftError } from "@/lib/ingest/types";

describe("normalizeCursor", () => {
  it("emits one monthly $40 seat fact per distinct user, keyed by email", () => {
    const facts = normalizeCursor(cursorUsageFixture);
    // gareth (deduped across two days), tom, contractor = 3
    expect(facts).toHaveLength(3);
    const gareth = facts.find((f) => f.entityKey === "gareth.jones@intenthq.com")!;
    expect(gareth).toMatchObject({
      source: "cursor",
      day: "2026-06-01",
      costType: "seat",
      costUsd: 40,
    });
  });

  it("fails loudly on schema drift rather than writing garbage", () => {
    expect(() => normalizeCursor({} as CursorUsageResponse)).toThrow(SchemaDriftError);
  });
});
