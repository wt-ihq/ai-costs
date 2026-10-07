import { describe, expect, it } from "vitest";
import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import { caveatsFor, syncSucceededSince, monthlyReadiness, sourceFreshness, type SyncRunRow } from "./freshness";
import { periodFor } from "./schedule";

const runs: SyncRunRow[] = [
  { source: "cursor", status: "success", startedAt: "2026-09-29T06:00:05Z" },
  { source: "cursor", status: "failed", startedAt: "2026-09-30T06:00:05Z" },
  { source: "anthropic", status: "success", startedAt: "2026-09-30T06:00:04Z" },
  { source: "okta", status: "success", startedAt: "2026-09-30T06:00:01Z" },
];

describe("sourceFreshness", () => {
  it("reports every SYNCED source: latest run failed, and the latest successful run's day", () => {
    const f = sourceFreshness(runs);
    expect(f.map((x) => x.source).sort()).toEqual(["anthropic", "cursor", "openai", "openrouter", "vercel"]);
    expect(f.find((x) => x.source === "cursor")).toEqual({ source: "cursor", lastSyncFailed: true, lastSuccessDay: "2026-09-29" });
    expect(f.find((x) => x.source === "anthropic")).toEqual({ source: "anthropic", lastSyncFailed: false, lastSuccessDay: "2026-09-30" });
    expect(f.find((x) => x.source === "openai")).toEqual({ source: "openai", lastSyncFailed: false, lastSuccessDay: null });
  });
  it("never includes manual or identity sources (no freshness for imports, okta)", () => {
    const f = sourceFreshness([...runs, { source: "chatgpt_business", status: "failed", startedAt: "2026-09-30T06:00:00Z" }]);
    expect(f.some((x) => (x.source as string) === "okta" || x.source === "chatgpt_business" || x.source === "claude_team")).toBe(false);
  });
});

describe("syncSucceededSince", () => {
  it("counts only spend sources (not okta), and only runs on or after the given UTC day", () => {
    expect(syncSucceededSince(runs, "2026-09-30")).toBe(true); // anthropic
    expect(syncSucceededSince(runs.filter((r) => r.source !== "anthropic"), "2026-09-30")).toBe(false);
    expect(syncSucceededSince(runs, "2026-09-29")).toBe(true);
    expect(syncSucceededSince(runs, "2026-10-01")).toBe(false);
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
  const weekly = periodFor("weekly", "2026-W39", new Date("2026-09-30T07:00:00Z")); // 21–27 Sep, toExclusive 2026-09-28
  const fresh = (source: "cursor" | "openai" | "anthropic", lastSyncFailed: boolean, lastSuccessDay: string | null) => ({ source, lastSyncFailed, lastSuccessDay });
  const caveats = (freshness: ReturnType<typeof fresh>[], used: string[]) =>
    caveatsFor({ period: weekly, sourcesUsed: new Set(used), freshness, missingImports: [] });

  it("warns when a used synced source's latest run failed, citing its last successful sync", () => {
    expect(caveats([fresh("cursor", true, "2026-09-29")], ["cursor"])).toEqual(["⚠ Cursor data may be incomplete (last synced 29 Sep)"]);
  });
  it("warns when no successful run is on/after the period's end", () => {
    expect(caveats([fresh("cursor", false, "2026-09-27")], ["cursor"])).toEqual(["⚠ Cursor data may be incomplete (last synced 27 Sep)"]);
  });
  it("warns without a date when there is no successful run in the window", () => {
    expect(caveats([fresh("cursor", false, null)], ["cursor"])).toEqual(["⚠ Cursor data may be incomplete"]);
  });
  it("is silent when the latest run succeeded on/after the period's end", () => {
    expect(caveats([fresh("cursor", false, "2026-09-28"), fresh("anthropic", false, "2026-09-30")], ["cursor", "anthropic"])).toEqual([]);
  });
  it("warns only about sources this recipient actually uses", () => {
    expect(caveats([fresh("cursor", false, "2026-09-30"), fresh("openai", true, null), fresh("anthropic", false, "2026-09-30")], ["cursor", "anthropic"])).toEqual([]);
  });
  it("never gives a manual source a freshness caveat (sourceFreshness → caveatsFor, end to end)", () => {
    const freshness = sourceFreshness([{ source: "anthropic", status: "success", startedAt: "2026-09-30T06:00:04Z" }]);
    expect(caveatsFor({ period: weekly, sourcesUsed: new Set(["chatgpt_business", "claude_team"]), freshness, missingImports: [] })).toEqual([]);
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
