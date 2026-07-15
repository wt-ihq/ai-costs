import { describe, expect, it } from "vitest";
import {
  seriesOrder, treemapByDim, SHARED_SEATS,
  scorecardFor, rankTeams, rankPeople, rankAllStaff, lineItems, trendForPeriod, type ShapeFact,
  dimLabel, dimColorFor,
} from "./shape";
import { parsePeriod } from "./period";
import type { TrendPoint } from "./types";
import { VENDOR_LABEL } from "@/lib/types";
import { OTHER_TOOL_PALETTE } from "@/lib/colors";

const rows: ShapeFact[] = [
  { day: "2026-05-03", source: "cursor", costType: "seat", costUsd: 40, employeeId: "a", department: "Eng", fullName: "A", entityKey: "a@x", model: "" },
  { day: "2026-06-01", source: "cursor", costType: "seat", costUsd: 40, employeeId: "a", department: "Eng", fullName: "A", entityKey: "a@x", model: "" },
  { day: "2026-06-09", source: "anthropic", costType: "metered", costUsd: 100, employeeId: "a", department: "Eng", fullName: "A", entityKey: "k1", model: "opus" },
];
const june = rows.filter((r) => r.day.startsWith("2026-06"));

describe("treemapByDim", () => {
  it("sizes nodes by spend, sorted desc, colored", () => {
    const t = treemapByDim(june, "vendor");
    expect(t[0]).toMatchObject({ key: "anthropic", value: 100 });
    expect(t[1]).toMatchObject({ key: "cursor", value: 40 });
    expect(t[0].color).toBeTruthy();
  });
  it("collapses beyond topN into an 'Other' node", () => {
    const many: ShapeFact[] = Array.from({ length: 10 }, (_, i) => ({
      day: "2026-06-01", source: "openai", costType: "metered", costUsd: 10 - i, employeeId: null, department: null, fullName: null, entityKey: `k${i}`, model: `m${i}`,
    }));
    const t = treemapByDim(many, "model", 3);
    expect(t).toHaveLength(4);
    expect(t[3].key).toBe("__other__");
  });
});

describe("scorecardFor", () => {
  it("totals the given (period-scoped) rows with a cost-type split", () => {
    const sc = scorecardFor(june); // 2026-06 rows: cursor seat 40 + anthropic metered 100
    expect(sc).toMatchObject({ total: 140, seat: 40, metered: 100, overage: 0 });
  });
});

describe("rankTeams", () => {
  it("ranks departments by spend with per-head + drill href", () => {
    const r = rankTeams(june, new Map([["Eng", 2]]));
    expect(r[0]).toMatchObject({ id: "Eng", label: "Eng", total: 140, perHead: 70 });
    expect(r[0].href).toContain("/explore/");
  });

  it("attaches a spend split: vendors sorted desc, cost types in canonical order", () => {
    const r = rankTeams(june, new Map([["Eng", 2]]));
    // vendor split: anthropic 100 > cursor 40 (by value)
    expect(r[0].segments?.vendor).toMatchObject([
      { key: "anthropic", value: 100 },
      { key: "cursor", value: 40 },
    ]);
    // cost_type split: canonical seat → overage → metered, NOT by value —
    // seat leads even though metered (100) outweighs it (40).
    expect(r[0].segments?.cost_type).toMatchObject([
      { key: "seat", value: 40 },
      { key: "metered", value: 100 },
    ]);
  });
});

describe("rankPeople", () => {
  it("ranks people, flags idle seats, links to individual", () => {
    const idleRows: ShapeFact[] = [
      { day: "2026-06-01", source: "claude_team", costType: "seat", costUsd: 30, employeeId: "b", department: "Eng", fullName: "Bob", entityKey: "b@x", model: "" },
    ];
    const r = rankPeople(idleRows, "Eng", [{ id: "b", fullName: "Bob" }]);
    expect(r[0]).toMatchObject({ id: "b", label: "Bob", total: 30, idle: true });
    expect(r[0].href).toBe("/explore/Eng/b");
  });
});

describe("lineItems", () => {
  it("groups by vendor·cost-type·model/entity, sorted desc", () => {
    const li = lineItems(june);
    expect(li[0]).toMatchObject({ total: 100 });
    expect(li[0].label).toContain(VENDOR_LABEL.anthropic);
  });
});

describe("rankAllStaff", () => {
  it("lists every employee with period spend, $0 included, sorted desc, linked", () => {
    const r = rankAllStaff(june, [
      { id: "a", fullName: "A", department: "Eng" },
      { id: "z", fullName: "Z", department: "Sales" },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ id: "a", label: "A", total: 140, sub: "Eng" });
    expect(r[1]).toMatchObject({ id: "z", total: 0, sub: "Sales" }); // roster-driven: $0 kept
    expect(r[0].href).toBe("/explore/Eng/a");
  });
  it("routes employees with no department under Unattributed", () => {
    const r = rankAllStaff([], [{ id: "n", fullName: "N", department: null }]);
    expect(r[0].href).toBe("/explore/Unattributed/n");
  });
});

const NOW2 = new Date("2026-06-17T12:00:00Z");

describe("trendForPeriod", () => {
  it("month granularity buckets by day and zero-fills the month", () => {
    const t = trendForPeriod(rows, parsePeriod("2026-06", NOW2), "vendor");
    expect(t).toHaveLength(30);
    expect(t.find((p) => p.label === "1")).toMatchObject({ cursor: 40 });
    expect(t.find((p) => p.label === "9")).toMatchObject({ anthropic: 100 });
    expect(t.find((p) => p.label === "2")).toEqual({ label: "2" }); // zero-filled, no series
  });
  it("year granularity buckets by month", () => {
    const t = trendForPeriod(rows, parsePeriod("2026", NOW2), "vendor");
    expect(t).toHaveLength(12);
    expect(t.find((p) => p.label === "May")).toMatchObject({ cursor: 40 });
    expect(t.find((p) => p.label === "Jun")).toMatchObject({ cursor: 40, anthropic: 100 });
  });
  it("quarter granularity buckets by 7-day window", () => {
    const t = trendForPeriod(rows, parsePeriod("2026-Q2", NOW2), "vendor");
    expect(t).toHaveLength(13); // Q2 2026: Apr 1 to Jun 30 = 91 days = 13 weekly buckets
    const totalCursor = t.reduce((s, p) => s + ((p.cursor as number) ?? 0), 0);
    const totalAnthropic = t.reduce((s, p) => s + ((p.anthropic as number) ?? 0), 0);
    expect(totalCursor).toBe(80); // both May 3 and Jun 1 rows
    expect(totalAnthropic).toBe(100); // Jun 9 row
    expect(t.filter((p) => p.anthropic).length).toBe(1); // exactly one bucket has anthropic
  });
  it("excludes rows outside the period range", () => {
    const t = trendForPeriod(rows, parsePeriod("2026-05", NOW2), "vendor"); // only the 2026-05-03 row
    const total = t.reduce((s, p) => s + ((p.cursor as number) ?? 0) + ((p.anthropic as number) ?? 0), 0);
    expect(total).toBe(40);
  });
});

describe("seriesOrder", () => {
  const points: TrendPoint[] = [
    // overage dominates by total — canonical order must still put seat first.
    { label: "May", seat: 40, overage: 500 },
    { label: "Jun", seat: 40, overage: 600, metered: 10 },
  ];

  it("cost_type dim: canonical seat → overage → metered regardless of totals", () => {
    expect(seriesOrder(points, "cost_type")).toEqual(["seat", "overage", "metered"]);
  });

  it("vendor dim: totals desc (unchanged behavior)", () => {
    const v: TrendPoint[] = [
      { label: "May", cursor: 40, anthropic: 500 },
      { label: "Jun", cursor: 40, anthropic: 600 },
    ];
    expect(seriesOrder(v, "vendor")).toEqual(["anthropic", "cursor"]);
  });

  it("ignores non-numeric fields and series absent from every point", () => {
    expect(seriesOrder([{ label: "May", overage: 5 }], "cost_type")).toEqual(["overage"]);
  });
});

describe("rankTeams — Shared seats split", () => {
  const seatFact = (entityKey: string, costUsd: number): ShapeFact => ({
    day: "2026-06-01", source: "chatgpt_business", costType: "seat", costUsd,
    employeeId: null, department: null, fullName: null, entityKey, model: "",
  });

  it("routes all unassigned-seat key variants to a pinned Shared seats row, not Unattributed", () => {
    const facts = [
      ...june, // Eng: 140
      seatFact("unassigned seats", 500),
      seatFact("unassigned seats (standard)", 300),
      seatFact("unassigned seats (premium)", 200),
      // genuinely unmatched key stays Unattributed
      { ...seatFact("ghost@nowhere.com", 10) },
    ];
    const r = rankTeams(facts, new Map([["Eng", 2]]));
    expect(r.map((x) => x.id)).toEqual(["Eng", SHARED_SEATS, "Unattributed"]);
    expect(r[1]).toMatchObject({ label: "Shared seats", total: 1000, href: undefined, perHead: null });
    expect(r[1].sub).toContain("backfilled");
    expect(r[2]).toMatchObject({ id: "Unattributed", total: 10 });
  });

  it("pins pseudo-rows last even when they dwarf real teams", () => {
    const r = rankTeams([...june, seatFact("unassigned seats", 99999)], new Map([["Eng", 2]]));
    expect(r[0].id).toBe("Eng");
    expect(r[r.length - 1].id).toBe(SHARED_SEATS);
  });

  it("omits zero-total pseudo-rows (no Shared seats row without unassigned facts)", () => {
    const r = rankTeams(june, new Map([["Eng", 2]]));
    expect(r.map((x) => x.id)).toEqual(["Eng"]);
  });

  it("Unattributed keeps the headcount and points at Data Health", () => {
    const r = rankTeams([...june, seatFact("ghost@nowhere.com", 10)], new Map([["Eng", 2], ["Unattributed", 64]]));
    const un = r.find((x) => x.id === "Unattributed");
    expect(un?.sub).toContain("64 people without a department");
    expect(un?.sub).toContain("Data Health");
  });
});

describe("tool-aware vendor dimension", () => {
  const toolFact = (model: string, costUsd: number, department = "Data Science"): ShapeFact => ({
    day: "2026-06-01", source: "other", costType: "seat", costUsd,
    employeeId: null, department, fullName: null, entityKey: model.toLowerCase() + "|" + department, model,
  });
  const toolColors = { Perplexity: OTHER_TOOL_PALETTE[2] };

  it("keys, labels, and colors other-facts by tool", () => {
    expect(dimLabel("vendor", "other:Perplexity")).toBe("Perplexity");
    expect(dimLabel("vendor", "cursor")).toBe("Cursor");
    expect(dimColorFor("vendor", "other:Perplexity", toolColors)).toBe(OTHER_TOOL_PALETTE[2]);
    expect(dimColorFor("vendor", "other:Unknown", toolColors)).toBe("#8b92a5"); // fallback grey
  });

  it("treemap gives each tool its own node", () => {
    const t = treemapByDim([toolFact("Perplexity", 100), toolFact("ElevenLabs", 40)], "vendor", 12, toolColors);
    expect(t.map((n) => n.label).sort()).toEqual(["ElevenLabs", "Perplexity"]);
    expect(t.find((n) => n.label === "Perplexity")?.color).toBe(OTHER_TOOL_PALETTE[2]);
  });

  it("rankTeams lands tool spend on the chosen department with colored segments", () => {
    const r = rankTeams([...june, toolFact("Perplexity", 100, "Eng")], new Map([["Eng", 2]]), toolColors);
    expect(r[0].id).toBe("Eng");
    expect(r[0].total).toBe(240);
    const seg = r[0].segments?.vendor.find((s) => s.key === "other:Perplexity");
    expect(seg).toMatchObject({ value: 100, color: OTHER_TOOL_PALETTE[2] });
  });

  it("rankPeople appends a non-person row per tool for department-attributed facts", () => {
    const r = rankPeople([...june, toolFact("Perplexity", 100, "Eng")], "Eng", [{ id: "a", fullName: "A" }], toolColors);
    const tool = r.find((x) => x.label === "Perplexity");
    expect(tool).toMatchObject({ total: 100, href: undefined });
    expect(tool?.sub).toContain("recurring");
  });

  it("trend series include per-tool keys", () => {
    const pts = trendForPeriod([toolFact("Perplexity", 100)], parsePeriod("2026-06", NOW2), "vendor");
    expect(pts.find((p) => p["other:Perplexity"] !== undefined)).toBeTruthy();
  });
});
