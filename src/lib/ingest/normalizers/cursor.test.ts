import { describe, expect, it } from "vitest";
import { normalizeCursor, normalizeCursorEvents, type CursorUsageResponse, type CursorEventsResponse } from "./cursor";
import { cursorUsageFixture } from "@/lib/ingest/fixtures/cursor-usage";
import { cursorEventsFixture } from "@/lib/ingest/fixtures/cursor-events";
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

describe("normalizeCursorEvents", () => {
  it("aggregates chargeable events into per-(email,day,model) overage facts", () => {
    const facts = normalizeCursorEvents(cursorEventsFixture);
    // gareth sonnet 6/1 (250+150), gareth gpt5 6/2, tom opus 6/1, contractor 6/3
    // — the $0 "Included in Business" event is dropped.
    expect(facts).toHaveLength(4);

    const garethSonnet = facts.find((f) => f.entityKey === "gareth.jones@intenthq.com" && f.model === "claude-sonnet-4-6")!;
    expect(garethSonnet).toMatchObject({
      source: "cursor",
      day: "2026-06-01",
      costType: "overage",
      costUsd: 4, // (250 + 150) / 100
      model: "claude-sonnet-4-6",
    });

    const tom = facts.find((f) => f.entityKey === "tom.reeve@intenthq.com")!;
    expect(tom).toMatchObject({ day: "2026-06-01", costType: "overage", costUsd: 10, model: "claude-opus-4-1" });
  });

  it("excludes zero-charge (seat-included) usage so seats are never double-counted", () => {
    const facts = normalizeCursorEvents(cursorEventsFixture);
    expect(facts.some((f) => f.model === "auto")).toBe(false);
  });

  it("fails loudly on schema drift rather than writing garbage", () => {
    expect(() => normalizeCursorEvents({} as CursorEventsResponse)).toThrow(SchemaDriftError);
  });
});
