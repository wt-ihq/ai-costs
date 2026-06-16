import { describe, expect, it } from "vitest";
import {
  trendByDim, dailyByDim, treemapByDim, seriesKeys,
  scorecardFor, rankTeams, rankPeople, lineItems, type ShapeFact,
} from "./shape";
import { VENDOR_LABEL } from "@/lib/types";

const rows: ShapeFact[] = [
  { day: "2026-05-03", source: "cursor", costType: "seat", costUsd: 40, employeeId: "a", department: "Eng", fullName: "A", entityKey: "a@x", model: "" },
  { day: "2026-06-01", source: "cursor", costType: "seat", costUsd: 40, employeeId: "a", department: "Eng", fullName: "A", entityKey: "a@x", model: "" },
  { day: "2026-06-09", source: "anthropic", costType: "metered", costUsd: 100, employeeId: "a", department: "Eng", fullName: "A", entityKey: "k1", model: "opus" },
];
const june = rows.filter((r) => r.day.startsWith("2026-06"));

describe("trendByDim", () => {
  it("stacks monthly spend by vendor across the given months", () => {
    const t = trendByDim(rows, ["2026-05", "2026-06"], "vendor");
    expect(t[0]).toMatchObject({ label: "2026-05", cursor: 40 });
    expect(t[1]).toMatchObject({ label: "2026-06", cursor: 40, anthropic: 100 });
  });
  it("stacks by cost type", () => {
    const t = trendByDim(rows, ["2026-06"], "cost_type");
    expect(t[0]).toMatchObject({ label: "2026-06", seat: 40, metered: 100 });
  });
});

describe("dailyByDim", () => {
  it("buckets a single month by day", () => {
    const d = dailyByDim(rows, "2026-06", "vendor");
    expect(d.find((p) => p.label === "2026-06-09")).toMatchObject({ anthropic: 100 });
    expect(d.find((p) => p.label === "2026-06-01")).toMatchObject({ cursor: 40 });
  });
});

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

describe("seriesKeys", () => {
  it("returns dim values present, ordered by total desc", () => {
    expect(seriesKeys(june, "vendor")).toEqual(["anthropic", "cursor"]);
  });
});

describe("scorecardFor", () => {
  it("totals current vs previous month with cost-type split", () => {
    const sc = scorecardFor(rows, "2026-06", "2026-05");
    expect(sc).toMatchObject({ total: 140, prevTotal: 40, seat: 40, metered: 100, overage: 0 });
  });
});

describe("rankTeams", () => {
  it("ranks departments by spend with per-head + drill href", () => {
    const r = rankTeams(june, new Map([["Eng", 2]]));
    expect(r[0]).toMatchObject({ id: "Eng", label: "Eng", total: 140, perHead: 70 });
    expect(r[0].href).toContain("/explore/");
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
