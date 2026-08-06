import { describe, expect, it } from "vitest";
import {
  seriesOrder, treemapByDim, SHARED_SEATS, rankTools,
  scorecardFor, rankTeams, rankPeople, rankAllStaff, lineItems, trendForPeriod, type ShapeFact,
  dimLabel, dimColorFor, vendorFixedShare,
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
  it("ranks people and links to the individual", () => {
    const rows: ShapeFact[] = [
      { day: "2026-06-01", source: "claude_team", costType: "seat", costUsd: 30, employeeId: "b", department: "Eng", fullName: "Bob", entityKey: "b@x", model: "" },
    ];
    const r = rankPeople(rows, "Eng", [{ id: "b", fullName: "Bob" }]);
    expect(r[0]).toMatchObject({ id: "b", label: "Bob", total: 30 });
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
  it("month granularity: monthly-level costs amortize across the month, daily spend stays on its day", () => {
    const t = trendForPeriod(rows, parsePeriod("2026-06", NOW2), "vendor");
    expect(t).toHaveLength(30);
    // The June seat (stamped Jun 1) spreads to 40/30 per day — no 1st-of-month spike.
    expect(t.find((p) => p.label === "1")?.cursor).toBeCloseTo(40 / 30, 6);
    expect(t.find((p) => p.label === "2")?.cursor).toBeCloseTo(40 / 30, 6);
    // Metered spend is genuinely daily — it stays on the 9th only.
    expect(t.find((p) => p.label === "9")).toMatchObject({ anthropic: 100 });
    expect(t.find((p) => p.label === "2")?.anthropic).toBeUndefined();
    // Amortization preserves the month's total.
    const totalCursor = t.reduce((s, p) => s + ((p.cursor as number) ?? 0), 0);
    expect(totalCursor).toBeCloseTo(40, 6);
  });
  it("year granularity buckets by month (no amortization needed)", () => {
    const t = trendForPeriod(rows, parsePeriod("2026", NOW2), "vendor");
    expect(t).toHaveLength(12);
    expect(t.find((p) => p.label === "May")).toMatchObject({ cursor: 40 });
    expect(t.find((p) => p.label === "Jun")).toMatchObject({ cursor: 40, anthropic: 100 });
  });
  it("quarter granularity buckets by 7-day window, amortizing monthly-level costs", () => {
    const t = trendForPeriod(rows, parsePeriod("2026-Q2", NOW2), "vendor");
    expect(t).toHaveLength(13); // Q2 2026: Apr 1 to Jun 30 = 91 days = 13 weekly buckets
    const totalCursor = t.reduce((s, p) => s + ((p.cursor as number) ?? 0), 0);
    const totalAnthropic = t.reduce((s, p) => s + ((p.anthropic as number) ?? 0), 0);
    expect(totalCursor).toBeCloseTo(80, 6); // both seat rows, spread but preserved
    expect(totalAnthropic).toBe(100); // Jun 9 row
    expect(t.filter((p) => p.anthropic).length).toBe(1); // exactly one bucket has anthropic
    // Seats spread across May AND June weeks — many buckets carry cursor spend.
    expect(t.filter((p) => p.cursor).length).toBeGreaterThan(8);
  });
  it("excludes rows outside the period range", () => {
    const t = trendForPeriod(rows, parsePeriod("2026-05", NOW2), "vendor"); // only the 2026-05-03 row
    const total = t.reduce((s, p) => s + ((p.cursor as number) ?? 0) + ((p.anthropic as number) ?? 0), 0);
    expect(total).toBeCloseTo(40, 6);
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

  it("vendor dim with a fixed-share map: flat spend sinks to the base, variable stacks on top", () => {
    const pts: TrendPoint[] = [
      { label: "Jul", cursor: 500, anthropic: 900, "other:Supabase": 30, claude_team: 100 },
    ];
    const share = new Map([
      ["claude_team", 1],
      ["other:Supabase", 1],
      ["cursor", 0.6],
      ["anthropic", 0],
    ]);
    // Fully-fixed first (ties by total desc), then mixed, then fully-variable
    // — even though anthropic has the biggest total.
    expect(seriesOrder(pts, "vendor", share)).toEqual(["claude_team", "other:Supabase", "cursor", "anthropic"]);
  });

  it("vendorFixedShare: monthly-level cost share per vendor-dim key", () => {
    const facts: ShapeFact[] = [
      { day: "2026-07-01", source: "openrouter", costType: "subscription", costUsd: 1500, employeeId: null, department: "AI Operations", fullName: null, entityKey: "openrouter|AI Operations", model: "OpenRouter" },
      { day: "2026-07-09", source: "openrouter", costType: "metered", costUsd: 500, employeeId: "a", department: "Eng", fullName: "A", entityKey: "a@x.com", model: "m" },
      { day: "2026-07-09", source: "anthropic", costType: "metered", costUsd: 100, employeeId: "a", department: "Eng", fullName: "A", entityKey: "k1", model: "opus" },
      { day: "2026-07-01", source: "other", costType: "subscription", costUsd: 30, employeeId: null, department: null, fullName: null, entityKey: "supabase", model: "Supabase" },
    ];
    const share = vendorFixedShare(facts);
    expect(share.get("openrouter")).toBe(0.75); // 1500 of 2000 is the flat fee
    expect(share.get("anthropic")).toBe(0);
    expect(share.get("other:Supabase")).toBe(1);
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

  it("Unattributed sub-line describes the row's actual facts, not the roster", () => {
    // Only an unmatched key in view: no people count, no projects mention —
    // the roster's 64 department-less employees must NOT leak in.
    const r = rankTeams([...june, seatFact("ghost@nowhere.com", 10)], new Map([["Eng", 2], ["Unattributed", 64]]));
    const un = r.find((x) => x.id === "Unattributed");
    expect(un?.sub).toBe("unmatched keys — see Data");
  });

  it("Unattributed names people/projects/unmatched by what's present in the filtered facts", () => {
    const personNoDept: ShapeFact = {
      day: "2026-06-01", source: "cursor", costType: "seat", costUsd: 40,
      employeeId: "emp1", department: null, fullName: "New Joiner", entityKey: "nj@x.com", model: "",
    };
    const vercelPlan: ShapeFact = {
      day: "2026-06-01", source: "vercel", costType: "subscription", costUsd: 20,
      employeeId: null, department: null, fullName: null, entityKey: "prj_abc", model: "",
    };
    const r = rankTeams([...june, personNoDept, vercelPlan], new Map([["Eng", 2], ["Unattributed", 64]]));
    const un = r.find((x) => x.id === "Unattributed");
    expect(un?.sub).toBe("1 person without a department · unassigned projects & team-level charges — see Data");
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

  it("department-attributed tool facts surface via rankTools, not rankPeople", () => {
    // Superseded behavior: tools used to be appended inside rankPeople; they
    // now render as their own "Tools" list (see the subscription describe).
    const people = rankPeople([...june, toolFact("Perplexity", 100, "Eng")], "Eng", [{ id: "a", fullName: "A" }], toolColors);
    expect(people.find((x) => x.label === "Perplexity")).toBeUndefined();
    const tools = rankTools([toolFact("Perplexity", 100, "Eng")], toolColors);
    expect(tools[0]).toMatchObject({ label: "Perplexity", total: 100, href: undefined });
  });

  it("trend series include per-tool keys", () => {
    const pts = trendForPeriod([toolFact("Perplexity", 100)], parsePeriod("2026-06", NOW2), "vendor");
    expect(pts.find((p) => p["other:Perplexity"] !== undefined)).toBeTruthy();
  });
});

describe("subscription cost type", () => {
  const subFact = (costUsd: number, department = "Eng"): ShapeFact => ({
    day: "2026-06-01", source: "other", costType: "subscription", costUsd,
    employeeId: null, department, fullName: null, entityKey: "openrouter|" + department, model: "OpenRouter",
  });

  it("scorecardFor splits subscription out of seat", () => {
    const sc = scorecardFor([...june, subFact(1863)]);
    expect(sc).toMatchObject({ seat: 40, subscription: 1863, overage: 0, metered: 100 });
  });

  it("stacks canonically: seat → subscription → overage → metered", () => {
    const pts: TrendPoint[] = [{ label: "Jun", metered: 5, subscription: 1863, seat: 40, overage: 1 }];
    expect(seriesOrder(pts, "cost_type")).toEqual(["seat", "subscription", "overage", "metered"]);
  });

  it("rankPeople returns humans only; rankTools returns the tool rows", () => {
    const people = rankPeople([...june, subFact(1863)], "Eng", [{ id: "a", fullName: "A" }]);
    expect(people.find((r) => r.label === "OpenRouter")).toBeUndefined();
    expect(people.find((r) => r.label === "A")).toBeTruthy();

    const tools = rankTools([...june, subFact(1863), subFact(37)], { OpenRouter: "#60a5fa" });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ label: "OpenRouter", total: 1900, href: undefined });
    expect(tools[0].sub).toContain("recurring");
    expect(tools[0].segments?.vendor[0].color).toBe("#60a5fa");
  });
});

describe("vendor-tagged subscription facts (real-vendor recurring entries)", () => {
  // A recurring entry tagged with a real vendor (e.g. the OpenRouter platform
  // fee) materializes under that source, so Explore shows ONE vendor row
  // whose composition splits subscription vs synced usage.
  const taggedSub = (costUsd: number, department: string | null = "AI Operations"): ShapeFact => ({
    day: "2026-06-01", source: "openrouter", costType: "subscription", costUsd,
    employeeId: null, department, fullName: null, entityKey: "openrouter|" + (department ?? ""), model: "OpenRouter",
  });
  const meteredFact = (costUsd: number): ShapeFact => ({
    day: "2026-06-09", source: "openrouter", costType: "metered", costUsd,
    employeeId: "a", department: "Eng", fullName: "A", entityKey: "a@x.com", model: "sonnet",
  });

  it("merges into the vendor's row on the vendor dim (one key, not other:<tool>)", () => {
    const nodes = treemapByDim([taggedSub(1500), meteredFact(100)], "vendor");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ key: "openrouter", label: VENDOR_LABEL.openrouter, value: 1600 });
  });

  it("surfaces in rankTools by tool name, and never in rankPeople", () => {
    const tools = rankTools([taggedSub(1500), meteredFact(100)]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ label: "OpenRouter", total: 1500 });

    const people = rankPeople([taggedSub(1500), meteredFact(100)], "Eng", [{ id: "a", fullName: "A" }]);
    expect(people.map((p) => p.label)).toEqual(["A"]);
  });

  it("an undepartmented tagged subscription reads as team-level charge, not an unmatched key", () => {
    const r = rankTeams([taggedSub(1500, null)], new Map());
    const unattributed = r.find((t) => t.label === "Unattributed");
    expect(unattributed?.sub).toContain("team-level charges");
    expect(unattributed?.sub).not.toContain("unmatched keys");
  });

  it("workspace-keyed metered usage surfaces in rankTools as an OpenRouter workspace row", () => {
    const wsFact: ShapeFact = {
      day: "2026-07-02", source: "openrouter", costType: "metered", costUsd: 7,
      employeeId: null, department: "AI Operations", fullName: null, entityKey: "AI Operations", model: "moonshotai/kimi-k3",
    };
    const tools = rankTools([wsFact, meteredFact(100)]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ label: "AI Operations", total: 7, sub: "OpenRouter workspace key" });
  });
});

describe("rankTools with Vercel projects", () => {
  const vercelFact = (entityKey: string, costUsd: number): ShapeFact => ({
    day: "2026-07-01", source: "vercel", costType: "metered", costUsd,
    employeeId: null, department: "Technology", fullName: null, entityKey, model: "Function Invocations",
  });

  it("lists Vercel projects beside recurring tools, each with the right sub", () => {
    const rows = rankTools([
      vercelFact("ai-costs", 12.5), vercelFact("ai-costs", 2.5),
      { day: "2026-07-01", source: "other", costType: "subscription", costUsd: 100, employeeId: null, department: "Technology", fullName: null, entityKey: "openrouter|Technology", model: "OpenRouter" },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["OpenRouter", "ai-costs"]); // total desc
    expect(rows.find((r) => r.label === "ai-costs")).toMatchObject({ total: 15, href: undefined });
    expect(rows.find((r) => r.label === "ai-costs")?.sub).toBe("Vercel project");
    expect(rows.find((r) => r.label === "OpenRouter")?.sub).toContain("recurring");
  });
});
