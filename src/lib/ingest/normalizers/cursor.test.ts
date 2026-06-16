import { describe, expect, it } from "vitest";
import { normalizeCursor, type CursorUsageResponse } from "./cursor";
import { SchemaDriftError } from "@/lib/ingest/types";

const fixture: CursorUsageResponse = {
  data: [
    {
      date: "2026-06-01",
      email: "Alice@IntentHQ.com",
      model: "claude-sonnet-4-6",
      totalTokens: 12000,
      requestCount: 8,
      costCents: 250,
    },
  ],
};

describe("normalizeCursor", () => {
  it("maps a usage row to a metered spend fact in USD, lowercasing email", () => {
    const [fact] = normalizeCursor(fixture);
    expect(fact).toMatchObject({
      source: "cursor",
      day: "2026-06-01",
      costType: "metered",
      entityKey: "alice@intenthq.com",
      costUsd: 2.5,
      tokens: 12000,
      requests: 8,
      model: "claude-sonnet-4-6",
    });
  });

  it("fails loudly on schema drift rather than writing garbage", () => {
    expect(() => normalizeCursor({} as CursorUsageResponse)).toThrow(SchemaDriftError);
  });
});
