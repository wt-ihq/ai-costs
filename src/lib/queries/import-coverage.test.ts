import { describe, expect, it } from "vitest";
import { buildImportCoverage, type CoverageFactRow, type CoverageImportRow } from "./import-coverage";

const fact = (over: Partial<CoverageFactRow>): CoverageFactRow => ({
  day: "2026-06-01",
  source: "chatgpt_business",
  costType: "overage",
  costUsd: 10,
  ...over,
});

const log = (over: Partial<CoverageImportRow>): CoverageImportRow => ({
  source: "chatgpt_business",
  kind: "clipboard",
  dataAsOf: "2026-06-15",
  createdAt: "2026-06-16T09:00:00Z",
  status: "success",
  ...over,
});

describe("buildImportCoverage", () => {
  it("returns [] with no facts", () => {
    expect(buildImportCoverage([], [log({})], "2026-07")).toEqual([]);
  });

  it("sums per column, fills month gaps to nowMonth, newest first", () => {
    const rows = buildImportCoverage(
      [
        fact({ day: "2026-05-01", costType: "seat", costUsd: 25 }),
        fact({ day: "2026-05-01", costType: "overage", costUsd: 10 }), // chatgpt: seat+overage merged
        fact({ day: "2026-05-01", source: "claude_team", costType: "overage", costUsd: 7 }),
        fact({ day: "2026-07-01", source: "claude_team", costType: "seat", costUsd: 30 }),
      ],
      [],
      "2026-07",
    );
    expect(rows.map((r) => r.month)).toEqual(["2026-07", "2026-06", "2026-05"]);
    expect(rows[2].chatgpt).toEqual({ totalUsd: 35, lastImport: null });
    expect(rows[2].claudeSpend).toEqual({ totalUsd: 7, lastImport: null });
    expect(rows[2].claudeSeats).toBeNull();
    expect(rows[1]).toEqual({ month: "2026-06", chatgpt: null, claudeSpend: null, claudeSeats: null });
    expect(rows[0].claudeSeats).toEqual({ totalUsd: 30, lastImport: null });
  });

  it("maps lastImport per column by source/kind, latest success wins, failures ignored", () => {
    const rows = buildImportCoverage(
      [
        fact({ day: "2026-06-01" }),
        fact({ day: "2026-06-01", source: "claude_team", costType: "seat", costUsd: 30 }),
      ],
      [
        log({ createdAt: "2026-06-10T09:00:00Z" }),
        log({ createdAt: "2026-06-20T09:00:00Z" }), // later success wins
        log({ createdAt: "2026-06-25T09:00:00Z", status: "failed" }), // ignored
        log({ source: "claude_team", kind: "csv", createdAt: "2026-06-05T12:00:00Z" }),
      ],
      "2026-06",
    );
    expect(rows[0].chatgpt?.lastImport).toBe("2026-06-20");
    expect(rows[0].claudeSeats?.lastImport).toBe("2026-06-05");
    expect(rows[0].claudeSpend).toBeNull();
  });
});
