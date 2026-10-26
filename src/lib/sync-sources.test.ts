import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYNC_SOURCE_LABEL, syncSourceLabel } from "./sync-sources";

describe("sync source names", () => {
  it("names every source the sync runs", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/ingest/run-all.ts"), "utf8");
    // Okta is `run("okta", …)`; the rest are `["name", () => …]` lane entries.
    const sources = [...src.matchAll(/(?:run\(|\[)"([a-z_]+)", /g)].map((m) => m[1]);
    expect(sources.length).toBeGreaterThanOrEqual(11);
    expect(sources.filter((s) => !(s in SYNC_SOURCE_LABEL))).toEqual([]);
  });

  it("falls back to the raw name", () => {
    expect(syncSourceLabel("ecb")).toBe("Exchange rates (ECB)");
    expect(syncSourceLabel("something_new")).toBe("something_new");
  });
});
