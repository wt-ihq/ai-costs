import { describe, expect, it } from "vitest";
import {
  treemapByDim,
  scorecardFor, rankTeams, rankPeople, rankAllStaff, lineItems, trendForPeriod, type ShapeFact,
} from "./shape";
import { parsePeriod } from "./period";
import { VENDOR_LABEL } from "@/lib/types";

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

  it("attaches a spend split for both dims, sorted desc", () => {
    const r = rankTeams(june, new Map([["Eng", 2]]));
    // vendor split: anthropic 100 > cursor 40
    expect(r[0].segments?.vendor).toEqual([
      { key: "anthropic", value: 100 },
      { key: "cursor", value: 40 },
    ]);
    // cost_type split: metered 100 > seat 40
    expect(r[0].segments?.cost_type).toEqual([
      { key: "metered", value: 100 },
      { key: "seat", value: 40 },
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
