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

  it("hides line items that would show as $0.00, but keeps them in the card total", () => {
    const out = buildPlatformRows(
      [
        { source: "vercel", entityKey: "team", model: "Additional Team Seats", costUsd: 277, ownerName: null },
        { source: "vercel", entityKey: "team", model: "Blob Simple Operations", costUsd: 0, ownerName: null },
        { source: "vercel", entityKey: "team", model: "Drive Reads", costUsd: 0.004, ownerName: null },
      ],
      new Map(),
    );
    expect(out[0].models).toEqual([{ model: "Additional Team Seats", cost: 277 }]);
    expect(out[0].total).toBeCloseTo(277.004); // the total stays exact
  });

  it("drops an entity with no spend at all", () => {
    const out = buildPlatformRows(
      [
        { source: "vercel", entityKey: "team", model: "Pro", costUsd: 18.48, ownerName: null },
        { source: "vercel", entityKey: "idle-project", model: "Function Duration", costUsd: 0, ownerName: null },
      ],
      new Map(),
    );
    expect(out.map((e) => e.entityKey)).toEqual(["team"]);
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

describe("packApiPlatformsScope", () => {
  it("round-trips the scope, owners and empty models included", async () => {
    const { packApiPlatformsScope, unpackApiPlatformsScope } = await import("./api-platforms");
    const scope = {
      earliest: "2026-05",
      names: [["anthropic:k1", "Prod key"]] as [string, string][],
      rows: [
        { day: "2026-05-01", source: "anthropic" as const, entityKey: "k1", model: "opus", costUsd: 12.5, ownerName: "Ada" },
        { day: "2026-05-01", source: "vercel" as const, entityKey: "web", model: "", costUsd: 0.25, ownerName: null },
        { day: "2026-05-02", source: "anthropic" as const, entityKey: "k1", model: "opus", costUsd: 3, ownerName: "Ada" },
      ],
    };
    const packed = packApiPlatformsScope(scope);
    expect(packed.days).toEqual(["2026-05-01", "2026-05-02"]);
    expect(packed.owners).toEqual(["Ada"]);
    expect(unpackApiPlatformsScope(packed)).toEqual(scope);
  });
});
