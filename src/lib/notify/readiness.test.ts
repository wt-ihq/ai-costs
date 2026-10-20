import { describe, expect, it } from "vitest";
import type { SyncRunRow } from "./freshness";
import { importsInUseSince, outstandingShort, readinessSyncSince, syncsOutstanding, weekReadiness, type ManualImportRow } from "./readiness";

const WEEK = { from: "2026-10-12", toExclusive: "2026-10-19" }; // Mon 12 – Sun 18 Oct
const ok = (source: string, startedAt: string): SyncRunRow => ({ source, status: "success", startedAt });
const bad = (source: string, startedAt: string): SyncRunRow => ({ source, status: "failed", startedAt });
const imp = (source: string, kind: string, dataAsOf: string): ManualImportRow => ({ source, kind, dataAsOf });
const runs = [ok("cursor", "2026-10-19T06:00:00Z"), ok("anthropic", "2026-10-19T06:00:00Z")];
const imports = [imp("chatgpt_business", "csv", "2026-10-18"), imp("claude_team", "clipboard", "2026-10-18")];

describe("weekReadiness", () => {
  it("is ready once every source in use synced since the week ended and both imports reach Sunday", () => {
    expect(weekReadiness({ week: WEEK, syncRuns: runs, imports })).toEqual({ ready: true, outstanding: [] });
  });

  it("waits for a source that failed since the week ended", () => {
    const r = weekReadiness({ week: WEEK, syncRuns: [...runs, ok("openai", "2026-10-17T06:00:00Z"), bad("openai", "2026-10-19T06:00:00Z")], imports });
    expect(r.outstanding).toEqual([{ kind: "sync", source: "openai", lastSuccessDay: "2026-10-17" }]);
  });

  it("ignores a source with no success in the window (not set up)", () => {
    expect(weekReadiness({ week: WEEK, syncRuns: [...runs, bad("vercel", "2026-10-19T06:00:00Z")], imports }).ready).toBe(true);
  });

  it("nothing synced at all is not ready", () => {
    const r = weekReadiness({ week: WEEK, syncRuns: [], imports });
    expect(r.ready).toBe(false);
    expect(r.outstanding.every((o) => o.kind === "sync")).toBe(true);
  });

  it("waits for ChatGPT credits through Sunday and a Claude Team paste as of Sunday", () => {
    const r = weekReadiness({ week: WEEK, syncRuns: runs, imports: [imp("chatgpt_business", "csv", "2026-10-11"), imp("claude_team", "clipboard", "2026-10-11")] });
    expect(r.outstanding).toEqual([{ kind: "chatgptCredits", through: "2026-10-11" }, { kind: "claudeSpend", asOf: "2026-10-11" }]);
  });

  it("a paste dated after Sunday counts", () => {
    expect(weekReadiness({ week: WEEK, syncRuns: runs, imports: [imp("claude_team", "clipboard", "2026-10-19")] }).ready).toBe(true);
  });

  it("an import nobody has used in two months isn't required", () => {
    expect(weekReadiness({ week: WEEK, syncRuns: runs, imports: [imp("chatgpt_business", "csv", "2026-07-31")] }).ready).toBe(true);
  });

  it("a week straddling two months needs the paste as of its Sunday", () => {
    const w = { from: "2026-10-26", toExclusive: "2026-11-02" };
    const r2 = [ok("cursor", "2026-11-02T06:00:00Z")];
    expect(weekReadiness({ week: w, syncRuns: r2, imports: [imp("claude_team", "clipboard", "2026-11-01")] }).ready).toBe(true);
    expect(weekReadiness({ week: w, syncRuns: r2, imports: [imp("claude_team", "clipboard", "2026-10-31")] }).outstanding).toEqual([{ kind: "claudeSpend", asOf: "2026-10-31" }]);
  });

  it("ignores roster uploads and failed imports' kinds it doesn't know", () => {
    expect(weekReadiness({ week: WEEK, syncRuns: runs, imports: [imp("chatgpt_business", "roster", "2026-10-01")] }).ready).toBe(true);
  });
});

describe("helpers", () => {
  it("syncsOutstanding lists in-use sources without a success since the day", () => {
    expect(syncsOutstanding([ok("cursor", "2026-10-18T06:00:00Z")], "2026-10-19")).toEqual([{ kind: "sync", source: "cursor", lastSuccessDay: "2026-10-18" }]);
  });
  it("importsInUseSince is two months back, from the 1st", () => {
    expect(importsInUseSince("2026-10-18")).toBe("2026-08-01");
    expect(importsInUseSince("2027-01-03")).toBe("2026-11-01");
  });
  it("readinessSyncSince is 14 days back, from midnight UTC", () => {
    expect(readinessSyncSince(new Date("2026-10-19T09:30:00Z"))).toBe("2026-10-05T00:00:00.000Z");
  });
  it("outstandingShort names each item", () => {
    expect(outstandingShort({ kind: "claudeSpend", asOf: "2026-10-11" })).toBe("Claude Team (pasted as of 11 Oct)");
    expect(outstandingShort({ kind: "chatgptCredits", through: "2026-10-11" })).toBe("ChatGPT credits (through 11 Oct)");
    expect(outstandingShort({ kind: "sync", source: "openai", lastSuccessDay: null })).toBe("OpenAI API sync");
  });
});
