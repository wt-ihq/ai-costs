import { describe, expect, it } from "vitest";
import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import { anySyncSucceededToday, caveatsFor, monthlyReadiness, sourceFreshness, type SyncRunRow } from "./freshness";
import { periodFor } from "./schedule";

const runs: SyncRunRow[] = [
  { source: "cursor", status: "success", startedAt: "2026-09-29T06:00:05Z" },
  { source: "cursor", status: "failed", startedAt: "2026-09-30T06:00:05Z" },
  { source: "anthropic", status: "success", startedAt: "2026-09-30T06:00:04Z" },
  { source: "okta", status: "success", startedAt: "2026-09-30T06:00:01Z" },
];

describe("sourceFreshness", () => {
  it("flags a source whose LATEST run failed and carries each usage horizon", () => {
    const f = sourceFreshness(runs, { cursor: "2026-09-28", anthropic: "2026-09-29", chatgpt_business: "2026-09-10", claude_team: "2026-09-01" });
    expect(f.find((x) => x.source === "cursor")).toEqual({ source: "cursor", lastSyncFailed: true, usageThrough: "2026-09-28" });
    expect(f.find((x) => x.source === "anthropic")).toEqual({ source: "anthropic", lastSyncFailed: false, usageThrough: "2026-09-29" });
    expect(f.find((x) => x.source === "chatgpt_business")).toEqual({ source: "chatgpt_business", lastSyncFailed: false, usageThrough: "2026-09-10" });
  });
  it("skips monthly-snapshot sources: Claude Team's usage lump is stamped on the 1st, not a daily horizon", () => {
    const f = sourceFreshness(runs, { claude_team: "2026-09-01" });
    expect(f.some((x) => x.source === "claude_team")).toBe(false);
  });
});

describe("anySyncSucceededToday", () => {
  it("counts only spend sources (not okta) and only today's runs", () => {
    const now = new Date("2026-09-30T07:00:00Z");
    expect(anySyncSucceededToday(runs, now)).toBe(true); // anthropic
    expect(anySyncSucceededToday(runs.filter((r) => r.source !== "anthropic"), now)).toBe(false);
    expect(anySyncSucceededToday(runs, new Date("2026-10-01T07:00:00Z"))).toBe(false);
  });
});

const cell = { totalUsd: 1, lastImport: null };
const row = (month: string, over: Partial<CoverageMonthRow> = {}): CoverageMonthRow => ({
  month, chatgptSeats: null, chatgptCredits: null, claudeSpend: null, claudeSeats: null, ...over,
});

describe("monthlyReadiness", () => {
  it("requires every manual column the org used in either of the two previous months", () => {
    const rows = [row("2026-09", { chatgptSeats: cell }), row("2026-08", { chatgptSeats: cell, claudeSpend: cell }), row("2026-07", { claudeSeats: cell })];
    expect(monthlyReadiness(rows, "2026-09")).toEqual({
      ready: false,
      missing: [
        { source: "claude_team", label: "Claude Team usage" },
        { source: "claude_team", label: "Claude Team seats" },
      ],
    });
  });
  it("is ready when nothing is missing, and when there is no manual data at all", () => {
    expect(monthlyReadiness([row("2026-09", { claudeSpend: cell }), row("2026-08", { claudeSpend: cell })], "2026-09").ready).toBe(true);
    expect(monthlyReadiness([], "2026-09")).toEqual({ ready: true, missing: [] });
  });
});

describe("caveatsFor", () => {
  const weekly = periodFor("weekly", "2026-W39", new Date("2026-09-30T07:00:00Z")); // 21–27 Sep
  it("warns only about sources this recipient actually uses", () => {
    const freshness = [
      { source: "cursor" as const, lastSyncFailed: false, usageThrough: "2026-09-26" },
      { source: "openai" as const, lastSyncFailed: true, usageThrough: "2026-09-29" },
      { source: "anthropic" as const, lastSyncFailed: false, usageThrough: "2026-09-29" },
    ];
    expect(caveatsFor({ period: weekly, sourcesUsed: new Set(["cursor", "anthropic"]), freshness, missingImports: [] })).toEqual([
      "⚠ Cursor data may be incomplete (last updated 26 Sep)",
    ]);
  });
  it("adds missing manual imports on monthly digests only, for used sources", () => {
    const monthly = periodFor("monthly", "2026-09", new Date("2026-10-05T07:00:00Z"));
    const missingImports = [{ source: "chatgpt_business" as const, label: "ChatGPT Business seats" }, { source: "claude_team" as const, label: "Claude Team usage" }];
    expect(caveatsFor({ period: monthly, sourcesUsed: new Set(["chatgpt_business"]), freshness: [], missingImports })).toEqual([
      "⚠ ChatGPT Business seats for September not imported yet",
    ]);
    expect(caveatsFor({ period: weekly, sourcesUsed: new Set(["chatgpt_business"]), freshness: [], missingImports })).toEqual([]);
  });
});
