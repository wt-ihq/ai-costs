import { describe, expect, it } from "vitest";
import { buildModelUsage, modelColor, modelComposition, rankPeople, rankTeams, summarize, trendByModel, type ModelUsageRow } from "./shape";
import { parsePeriod } from "@/lib/explore/period";

const rows: ModelUsageRow[] = [
  { day: "2026-06-01", model: "claude-sonnet-4.5", messages: 120, employeeId: "e1", fullName: "Gareth Jones", department: "Engineering" },
  { day: "2026-06-02", model: "claude-sonnet-4.5", messages: 80, employeeId: "e1", fullName: "Gareth Jones", department: "Engineering" },
  { day: "2026-06-01", model: "gpt-4o", messages: 30, employeeId: "e1", fullName: "Gareth Jones", department: "Engineering" },
  { day: "2026-06-01", model: "claude-opus-4.1", messages: 45, employeeId: "e2", fullName: "Tom Reeve", department: "Design" },
  { day: "2026-05-15", model: "gpt-4o", messages: 999, employeeId: "e2", fullName: "Tom Reeve", department: "Design" }, // out of period
];

const june = parsePeriod("2026-06", new Date("2026-06-29T00:00:00Z"));

describe("summarize", () => {
  it("totals messages, distinct users, model count, and top model in period", () => {
    const s = summarize(rows.filter((r) => r.day >= june.from && r.day < june.toExclusive));
    expect(s.messages).toBe(120 + 80 + 30 + 45);
    expect(s.activeUsers).toBe(2);
    expect(s.modelCount).toBe(3);
    expect(s.topModel).toBe("claude-sonnet-4.5"); // 200 messages
  });
});

describe("modelComposition", () => {
  it("ranks models by messages desc", () => {
    const bars = modelComposition(rows.filter((r) => r.day >= june.from && r.day < june.toExclusive));
    expect(bars.map((b) => b.key)).toEqual(["claude-sonnet-4.5", "claude-opus-4.1", "gpt-4o"]);
    expect(bars[0].value).toBe(200);
  });

  it("rolls the tail into an Other bucket past topN", () => {
    const many: ModelUsageRow[] = Array.from({ length: 15 }, (_, i) => ({
      day: "2026-06-01", model: `m${i}`, messages: 15 - i, employeeId: "e1", fullName: "X", department: "Eng",
    }));
    const bars = modelComposition(many, 12);
    expect(bars).toHaveLength(13);
    expect(bars[12].key).toBe("__other");
  });
});

describe("rankPeople / rankTeams", () => {
  it("ranks people by messages with their top model and a drill href", () => {
    const people = rankPeople(rows.filter((r) => r.day >= june.from && r.day < june.toExclusive));
    expect(people[0]).toMatchObject({ label: "Gareth Jones", messages: 230, sub: "claude-sonnet-4.5" });
    expect(people[0].href).toBe("/explore/Engineering/e1");
  });

  it("ranks teams by messages with active-people count", () => {
    const teams = rankTeams(rows.filter((r) => r.day >= june.from && r.day < june.toExclusive));
    expect(teams[0]).toMatchObject({ label: "Engineering", messages: 230, sub: "1 person" });
  });
});

describe("trendByModel", () => {
  it("buckets messages per model per day within the period", () => {
    const trend = trendByModel(rows.filter((r) => r.day >= june.from && r.day < june.toExclusive), june);
    const d1 = trend.find((p) => p.label === "1")!;
    expect(d1["claude-sonnet-4.5"]).toBe(120);
    expect(d1["gpt-4o"]).toBe(30);
  });
});

describe("modelColor", () => {
  it("gives known families an on-brand hue and is stable", () => {
    expect(modelColor("claude-sonnet-4.5")).toBe("#d2845a");
    expect(modelColor("gpt-4o")).toBe("#10a37f");
    expect(modelColor("auto")).toBe("#8b92a5");
    expect(modelColor("mystery-model")).toBe(modelColor("mystery-model"));
  });
});

describe("buildModelUsage", () => {
  it("excludes out-of-period rows from every section", () => {
    const data = buildModelUsage({ rows, earliest: "2026-05" }, june);
    expect(data.summary.messages).toBe(275); // the 999 May row is excluded
    expect(data.people).toHaveLength(2);
  });
});
