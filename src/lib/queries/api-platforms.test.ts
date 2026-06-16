import { describe, expect, it } from "vitest";
import { buildPlatformRows, type PlatformFactRow } from "./api-platforms";

const rows: PlatformFactRow[] = [
  { source: "anthropic", entityKey: "ak_prod", model: "claude-opus-4-8", costUsd: 412.5, ownerName: "Alice A" },
  { source: "anthropic", entityKey: "ak_prod", model: "claude-sonnet-4-6", costUsd: 88.2, ownerName: "Alice A" },
  { source: "openai", entityKey: "proj_search", model: "gpt-5", costUsd: 233.4, ownerName: "Bob B" },
];

describe("buildPlatformRows", () => {
  it("groups by source+entity with a model breakdown and owner, sorted by total", () => {
    const out = buildPlatformRows(rows, new Map([["anthropic:ak_prod", "Prod ingest key"]]));
    expect(out).toHaveLength(2);

    const top = out[0];
    expect(top).toMatchObject({ source: "anthropic", entityKey: "ak_prod", name: "Prod ingest key", owner: "Alice A" });
    expect(top.total).toBeCloseTo(500.7);
    expect(top.models[0]).toEqual({ model: "claude-opus-4-8", cost: 412.5 }); // largest first
    expect(out[1].name).toBe("proj_search"); // falls back to id when unnamed
  });
});
