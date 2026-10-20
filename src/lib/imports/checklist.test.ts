import { describe, expect, it } from "vitest";
import type { CoverageImportRow, CoverageMonthRow } from "@/lib/queries/import-coverage";
import { coverageView, importChecklist, monthEnd, monthName, shortDay } from "./checklist";

const imp = (source: string, kind: string, dataAsOf: string, createdAt = `${dataAsOf}T10:00:00Z`, status = "success"): CoverageImportRow => ({ source, kind, dataAsOf, createdAt, status });
const cell = (totalUsd: number, lastImport: string | null = null) => ({ totalUsd, lastImport });
const row = (month: string, over: Partial<CoverageMonthRow> = {}): CoverageMonthRow => ({
  month, chatgptSeats: cell(3450), chatgptCredits: cell(395), claudeSpend: cell(17829), claudeSeats: cell(5951), ...over,
});

describe("date helpers", () => {
  it("names months and days without locale surprises", () => {
    expect(monthName("2026-10")).toBe("October");
    expect(shortDay("2026-10-12")).toBe("12 Oct");
    expect(monthEnd("2026-09")).toBe("2026-09-30");
    expect(monthEnd("2024-02")).toBe("2024-02-29");
    expect(monthEnd("2026-12")).toBe("2026-12-31");
  });
});

describe("importChecklist", () => {
  const coverage = [row("2026-10"), row("2026-09", { chatgptSeats: cell(3550), claudeSeats: cell(5878) })];
  const imports = [
    imp("chatgpt_business", "csv", "2026-10-11", "2026-10-12T09:00:00Z"),
    imp("claude_team", "clipboard", "2026-10-12"),
    imp("claude_team", "clipboard", "2026-09-28"),
    imp("chatgpt_business", "roster", "2026-09-29"), // a tier upload is not the monthly seats task
  ];
  const base = { coverage, imports, seatEntries: [], today: "2026-10-16" };
  const item = (c: ReturnType<typeof importChecklist>, key: string) => c.items.find((i) => i.key === key)!;

  it("is about the current month, in a fixed order", () => {
    const c = importChecklist(base);
    expect(c.month).toBe("2026-10");
    expect(c.items.map((i) => i.key)).toEqual(["chatgptCredits", "claudeSpend", "chatgptSeats", "claudeSeats"]);
  });

  it("credits are done once a file reaches into the month, and say how far", () => {
    const i = item(importChecklist(base), "chatgptCredits");
    expect(i).toMatchObject({ done: true, status: "Imported through 11 Oct", detail: "October so far $395" });
    const none = item(importChecklist({ ...base, imports: [imp("chatgpt_business", "csv", "2026-09-30")] }), "chatgptCredits");
    expect(none).toMatchObject({ done: false, status: "Nothing for October yet" });
  });

  it("ignores failed imports", () => {
    const failed = importChecklist({ ...base, imports: [imp("chatgpt_business", "csv", "2026-10-11", undefined, "failed")] });
    expect(item(failed, "chatgptCredits").done).toBe(false);
  });

  it("Claude spend is done once this month's table is pasted", () => {
    expect(item(importChecklist(base), "claudeSpend")).toMatchObject({ done: true, status: "Pasted as of 12 Oct", detail: "October so far $17,829" });
  });

  it("Claude spend is due each week: pasted as of last Sunday", () => {
    const late = { ...base, today: "2026-10-20" }; // Tue: last Sunday is 18 Oct
    expect(item(importChecklist(late), "claudeSpend")).toMatchObject({ done: false, status: "Pasted as of 12 Oct · due as of 18 Oct", action: "Paste the spend table" });
    const none = { ...base, imports: base.imports.filter((i) => i.source !== "claude_team" || !i.dataAsOf.startsWith("2026-10")) };
    expect(item(importChecklist(none), "claudeSpend")).toMatchObject({ done: false, status: "Due: paste as of 11 Oct" });
  });

  it("before a month's first Sunday, the week just gone still needs a paste: this month's table", () => {
    const feb = { coverage: [], imports: [imp("claude_team", "clipboard", "2027-01-29")], seatEntries: [], today: "2027-02-01" }; // Monday the 1st
    expect(item(importChecklist(feb), "claudeSpend")).toMatchObject({ done: false, status: "Due: paste this month's table" });
    const dec = { coverage: [], imports: [imp("claude_team", "clipboard", "2026-11-30")], seatEntries: [], today: "2026-12-01" }; // last Sunday 29 Nov
    expect(item(importChecklist(dec), "claudeSpend")).toMatchObject({ done: true, status: "Pasted as of 30 Nov" });
  });

  it("seats are done only with this month's invoice counts, not a tier upload", () => {
    const c = importChecklist(base);
    expect(item(c, "chatgptSeats")).toMatchObject({ done: false, status: "No invoice counts yet", detail: "Estimated $3,450 from synced members" });
    const entered = importChecklist({
      ...base,
      seatEntries: [
        { vendor: "chatgpt_business", month: "2026-10", seats: 72 },
        { vendor: "chatgpt_business", month: "2026-10", seats: 35 },
      ],
    });
    expect(item(entered, "chatgptSeats")).toMatchObject({ done: true, status: "Entered: 107 seats" });
    expect(item(entered, "claudeSeats").done).toBe(false);
  });

  it("lists what last month still needs: credits must reach its last day, seats need counts", () => {
    const c = importChecklist(base);
    expect(c.previous.month).toBe("2026-09");
    // credits run to 11 Oct (past 30 Sep) and a September spend paste exists; seats have no counts.
    expect(c.previous.outstanding.map((i) => i.key)).toEqual(["chatgptSeats", "claudeSeats"]);
    const short = importChecklist({ ...base, imports: [imp("chatgpt_business", "csv", "2026-09-20")], seatEntries: [
      { vendor: "chatgpt_business", month: "2026-09", seats: 1 }, { vendor: "claude_team", month: "2026-09", seats: 1 },
    ] });
    expect(short.previous.outstanding.map((i) => [i.key, i.status])).toEqual([
      ["chatgptCredits", "Imported through 20 Sep only"],
      ["claudeSpend", "Not pasted"],
    ]);
  });

  it("last month is complete when nothing is outstanding", () => {
    const done = importChecklist({ ...base, seatEntries: [
      { vendor: "chatgpt_business", month: "2026-09", seats: 1 }, { vendor: "claude_team", month: "2026-09", seats: 1 },
    ] });
    expect(done.previous.outstanding).toEqual([]);
  });

  it("works across a year boundary", () => {
    const c = importChecklist({ ...base, coverage: [], today: "2027-01-03" });
    expect(c.month).toBe("2027-01");
    expect(c.previous.month).toBe("2026-12");
    expect(item(c, "chatgptCredits").detail).toBe("January so far $0.00");
  });
});

describe("coverageView", () => {
  const rows = [
    row("2026-10", { chatgptCredits: cell(395, "2026-10-12") }),
    row("2026-09", { chatgptCredits: null }),
    row("2026-08", { claudeSpend: null }),
    row("2026-07", { claudeSpend: cell(19631, "2026-07-31") }),
    row("2026-06", { claudeSpend: null }),
  ];
  const view = coverageView(rows, [{ vendor: "claude_team", month: "2026-07" }], "2026-10");
  const at = (month: string) => view.find((r) => r.month === month)!;

  it("labels imported cells with the import day", () => {
    expect(at("2026-10").chatgptCredits).toEqual({ kind: "value", usd: 395, note: "imported 12 Oct", warn: false });
    expect(at("2026-07").claudeSpend).toEqual({ kind: "value", usd: 19631, note: "pasted 31 Jul", warn: false });
  });

  it("tells a gap after tracking began from a month before it", () => {
    expect(at("2026-09").chatgptCredits).toEqual({ kind: "gap" });
    expect(at("2026-08").claudeSpend).toEqual({ kind: "gap" });
    expect(at("2026-06").claudeSpend).toEqual({ kind: "before" });
  });

  it("seats say whether invoice counts were entered; the current month without them is a warning", () => {
    expect(at("2026-07").claudeSeats).toEqual({ kind: "value", usd: 5951, note: "invoice entered", warn: false });
    expect(at("2026-08").claudeSeats).toEqual({ kind: "value", usd: 5951, note: "estimate", warn: false });
    expect(at("2026-10").claudeSeats).toEqual({ kind: "value", usd: 5951, note: "estimate · no counts yet", warn: true });
  });
});
