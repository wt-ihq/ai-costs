import { describe, expect, it } from "vitest";
import { buildPersonRows, buildPlatformRows, buildVendorTotals, type PlatformFactRow } from "./api-platforms";

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

const row = (over: Partial<PlatformFactRow>): PlatformFactRow => ({
  source: "anthropic",
  entityKey: "key_1",
  model: "claude-sonnet-5",
  costUsd: 10,
  ownerName: "Ada Lovelace",
  ...over,
});

describe("buildVendorTotals", () => {
  it("sums cost per vendor", () => {
    const totals = buildVendorTotals([
      row({ costUsd: 10 }),
      row({ costUsd: 5 }),
      row({ source: "openai", costUsd: 7 }),
    ]);
    expect(totals.get("anthropic")).toBe(15);
    expect(totals.get("openai")).toBe(7);
    expect(totals.size).toBe(2);
  });

  it("returns an empty map for no rows", () => {
    expect(buildVendorTotals([]).size).toBe(0);
  });
});

describe("buildPersonRows", () => {
  it("groups by owner, buckets null as Unattributed, sorts by total desc", () => {
    const people = buildPersonRows([
      row({ ownerName: "Ada Lovelace", costUsd: 5 }),
      row({ ownerName: "Grace Hopper", costUsd: 20 }),
      row({ ownerName: "Ada Lovelace", costUsd: 10 }),
      row({ ownerName: null, costUsd: 1 }),
    ]);
    expect(people).toEqual([
      { name: "Grace Hopper", total: 20 },
      { name: "Ada Lovelace", total: 15 },
      { name: "Unattributed", total: 1 },
    ]);
  });

  it("returns [] for no rows", () => {
    expect(buildPersonRows([])).toEqual([]);
  });
});
