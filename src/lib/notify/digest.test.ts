import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import type { CostType, Vendor } from "@/lib/types";
import { buildDigest, type DigestInput } from "./digest";
import { periodFor } from "./schedule";
import type { NotifyEmployee } from "./types";

const now = new Date("2026-09-30T07:00:00Z");
const emp = (id: string, fullName: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName, department: "Engineering", oktaId: null, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
const fact = (day: string, source: Vendor, costType: CostType, costUsd: number, employeeId: string | null, model = ""): ShapeFact => ({
  day, source, costType, costUsd, employeeId, department: "Engineering", fullName: null, entityKey: employeeId ?? "dept", model,
});

const people = [
  emp("m", "Priya Nair"),
  emp("a", "Alex Kim"),
  emp("s", "Sam Lee", { department: "Data Science" }),
  emp("l", "Former Person", { employmentStatus: "deprovisioned", leaveDate: "2026-09-26" }),
  emp("n", "New Joiner"),
];
const byId = new Map(people.map((p) => [p.id, p]));

const facts: ShapeFact[] = [
  fact("2026-09-22", "cursor", "overage", 30.1, "m"),
  fact("2026-09-23", "anthropic", "metered", 8.1, "m"),
  fact("2026-09-15", "cursor", "overage", 34.1, "m"), // previous week
  fact("2026-09-01", "cursor", "seat", 40, "m"), // monthly-level: not in weekly headline
  fact("2026-09-24", "cursor", "overage", 140, "a"),
  fact("2026-09-25", "anthropic", "metered", 96, "s"),
  fact("2026-09-21", "openrouter", "metered", 42, "l"), // leaver's spend still counts
  fact("2026-09-01", "claude_team", "overage", 500, "a"), // Claude Team monthly lump
  fact("2026-09-24", "other", "subscription", 999, null, "Figma AI"), // person-less
];

const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  recipient: byId.get("m")!, reportIds: ["a", "s", "l"], employeesById: byId, facts,
  period: periodFor("weekly", "2026-W39", now), now, sourceHorizons: {}, toolColors: {},
  freshness: [], missingImports: [], baseUrl: "https://x.test", ...over,
});

describe("buildDigest — weekly (usage basis)", () => {
  const d = buildDigest(input())!;

  it("headline is usage only, compared with the previous week", () => {
    expect(d.you).toMatchObject({ basis: "usage", headlineUsd: 38.2, prevUsd: 34.1, deltaPct: 12 });
    expect(d.you.byTool.map((t) => [t.key, t.label, t.usd])).toEqual([["cursor", "Cursor", 30.1], ["anthropic", "Anthropic API", 8.1]]);
  });

  it("excludes Claude Team's monthly lump and person-less facts from reports", () => {
    expect(d.reports).toMatchObject({ headlineUsd: 278, headcount: 2, othersCount: 0 });
    expect(d.reports!.top.map((p) => [p.name, p.usd])).toEqual([["Alex Kim", 140], ["Sam Lee", 96], ["Former Person", 42]]);
    expect(d.reports!.top[1].href).toBe("https://x.test/explore/Data%20Science/s");
  });

  it("carries a month-so-far line (all cost types) and a projection for the current month", () => {
    expect(d.you.month).toMatchObject({ monthLabel: "September", soFarUsd: 112.3, complete: false });
    expect(typeof d.you.month!.projectedUsd).toBe("number");
  });

  it("charts 8 weekly buckets with the current one last", () => {
    expect(d.you.chart).toHaveLength(8);
    expect(d.you.chart[7]).toMatchObject({ current: true, totalUsd: 38.2, byTool: { cursor: 30.1, anthropic: 8.1 } });
    expect(d.you.chart[6]).toMatchObject({ current: false, totalUsd: 34.1 });
  });

  it("links to the recipient's Explore page", () => {
    expect(d.dashboardUrl).toBe("https://x.test/explore/Engineering/m");
  });
});

describe("buildDigest — monthly (total basis)", () => {
  it("monthly total equals the person's summed facts to the cent, with no month line", () => {
    const aug = [fact("2026-08-01", "cursor", "seat", 40, "m"), fact("2026-08-10", "cursor", "overage", 20.05, "m"), fact("2026-07-03", "cursor", "overage", 7, "m")];
    const d = buildDigest(input({ facts: aug, reportIds: [], period: periodFor("monthly", "2026-08", now) }))!;
    expect(d.you).toMatchObject({ basis: "total", headlineUsd: 60.05, prevUsd: 7, month: null });
    expect(d.reports).toBeNull();
  });
});

describe("buildDigest — daily", () => {
  it("skips (null) when neither the recipient nor anyone in their tree had usage", () => {
    expect(buildDigest(input({ period: periodFor("daily", "2026-09-26", now) }))).toBeNull();
  });
  it("still sends when only a report had usage", () => {
    const d = buildDigest(input({ period: periodFor("daily", "2026-09-24", now) }))!;
    expect(d.you.headlineUsd).toBe(0);
    expect(d.reports!.headlineUsd).toBe(140);
  });
});

describe("buildDigest — edge cases", () => {
  it("a new joiner with no facts gets a valid $0 digest (no projection on an empty set)", () => {
    const d = buildDigest(input({ recipient: byId.get("n")!, reportIds: [], facts: [] }))!;
    expect(d.you).toMatchObject({ headlineUsd: 0, prevUsd: 0, deltaPct: null, byTool: [] });
    expect(d.you.month).toMatchObject({ soFarUsd: 0, projectedUsd: null });
  });

  it("top 5 + others add up to the reports total", () => {
    const many = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((id) => emp(id, `Person ${id}`));
    const f = many.map((p, i) => fact("2026-09-22", "cursor", "overage", 10 + i, p.id));
    const map = new Map([...byId, ...many.map((p) => [p.id, p] as const)]);
    const d = buildDigest(input({ facts: f, reportIds: many.map((p) => p.id), employeesById: map }))!;
    const r = d.reports!;
    expect(r.top).toHaveLength(5);
    expect(r.othersCount).toBe(2);
    expect(Math.round((r.top.reduce((s, p) => s + p.usd, 0) + r.othersUsd) * 100) / 100).toBe(r.headlineUsd);
  });

  it("top 5 + others equal the reports headline to the cent with fractional amounts", () => {
    const amounts = [10.333, 9.334, 8.334, 7.127, 6.334, 5.334, 4.334, 2.226];
    const many = amounts.map((_, i) => emp(`f${i}`, `Fraction ${i}`));
    const f = many.map((p, i) => fact("2026-09-22", "cursor", "overage", amounts[i], p.id));
    const map = new Map([...byId, ...many.map((p) => [p.id, p] as const)]);
    const r = buildDigest(input({ facts: f, reportIds: many.map((p) => p.id), employeesById: map }))!.reports!;
    expect(r.top).toHaveLength(5);
    expect(r.othersCount).toBe(3);
    const cents = (n: number) => Math.round(n * 100);
    expect(cents(r.top.reduce((s, p) => s + p.usd, 0) + r.othersUsd)).toBe(cents(r.headlineUsd));
  });

  it("caveats mention only sources the recipient or their tree used", () => {
    const d = buildDigest(input({
      freshness: [
        { source: "cursor", lastSyncFailed: true, lastSuccessDay: "2026-09-29" },
        { source: "openai", lastSyncFailed: true, lastSuccessDay: "2026-09-29" },
      ],
    }))!;
    expect(d.caveats).toEqual(["⚠ Cursor data may be incomplete (last synced 29 Sep)"]);
  });

  it("seat facts in the span don't count as using a source: an Anthropic-usage-only week gets no Cursor/ChatGPT caveat", () => {
    const d = buildDigest(input({
      reportIds: [],
      facts: [
        fact("2026-09-23", "anthropic", "metered", 12.5, "m"),
        fact("2026-09-01", "cursor", "seat", 40, "m"),
        fact("2026-09-01", "chatgpt_business", "seat", 25, "m"),
      ],
      freshness: [
        { source: "anthropic", lastSyncFailed: false, lastSuccessDay: "2026-09-30" },
        { source: "cursor", lastSyncFailed: true, lastSuccessDay: "2026-09-27" },
        { source: "chatgpt_business", lastSyncFailed: true, lastSuccessDay: null },
      ],
    }))!;
    expect(d.you.byTool.map((t) => t.key)).toEqual(["anthropic"]);
    expect(d.caveats).toEqual([]);
  });
});
