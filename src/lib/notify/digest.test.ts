import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import type { CostType, Vendor } from "@/lib/types";
import { buildDigest, buildTeamDigest, isTeamDigest, type DigestInput, type TeamDigestInput } from "./digest";
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
  freshness: [], missingImports: [], baseUrl: "https://x.test", includeFixed: false, ...over,
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

  it("carries a month-so-far line on the same basis (no seat) and a projection for the current month", () => {
    expect(d.you.month).toMatchObject({ monthLabel: "September", soFarUsd: 72.3, complete: false });
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
    const d = buildDigest(input({ facts: aug, reportIds: [], period: periodFor("monthly", "2026-08", now), includeFixed: true }))!;
    expect(d.you).toMatchObject({ basis: "total", headlineUsd: 60.05, prevUsd: 7, month: null });
    expect(d.reports).toBeNull();
  });
});

describe("fixed costs (seats & subscriptions)", () => {
  const weekly = (includeFixed: boolean, over: Partial<DigestInput> = {}) => buildDigest(input({ includeFixed, ...over }))!;

  it("excluded: monthly becomes usage only — seats and subscriptions dropped, Claude Team's usage kept", () => {
    const aug = [
      fact("2026-08-01", "cursor", "seat", 40, "m"),
      fact("2026-08-10", "cursor", "overage", 20.05, "m"),
      fact("2026-08-01", "claude_team", "overage", 100, "m"),
      fact("2026-07-03", "cursor", "overage", 7, "m"),
    ];
    const d = buildDigest(input({ facts: aug, reportIds: [], period: periodFor("monthly", "2026-08", now), includeFixed: false }))!;
    expect(d.you).toMatchObject({ basis: "usage", headlineUsd: 120.05, prevUsd: 7 });
  });

  it("included: a weekly adds each day's share of the month's seat (40 / 30 days × 7), on both weeks it compares", () => {
    const d = weekly(true);
    expect(d.you).toMatchObject({ basis: "total", headlineUsd: 47.53, prevUsd: 43.43 });
    expect(d.you.byTool.find((t) => t.key === "cursor")?.usd).toBe(39.43);
    expect(d.you.month).toMatchObject({ soFarUsd: 112.3 }); // the month line counts the seat in full
  });

  it("included: still leaves Claude Team's monthly usage lump out of daily/weekly", () => {
    expect(weekly(true).reports).toMatchObject({ headlineUsd: 278 });
  });

  it("included: a daily carries one day's share", () => {
    const d = buildDigest(input({ period: periodFor("daily", "2026-09-22", now), reportIds: [], includeFixed: true }))!;
    expect(d.you).toMatchObject({ basis: "total", headlineUsd: 31.43 });
  });

  it("included: a week spanning two months takes each month's share", () => {
    const facts2 = [fact("2026-09-01", "cursor", "seat", 30, "m"), fact("2026-10-01", "cursor", "seat", 62, "m")];
    const d = buildDigest(input({ facts: facts2, reportIds: [], period: periodFor("weekly", "2026-W40", new Date("2026-10-07T09:30:00Z")), includeFixed: true }))!;
    expect(d.you.headlineUsd).toBe(11); // Sep 28–30: 3 × $1 + Oct 1–4: 4 × $2
  });

  it("the chart follows the same rule", () => {
    expect(weekly(true).you.chart[7].totalUsd).toBe(47.53);
    expect(weekly(false).you.chart[7].totalUsd).toBe(38.2);
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

// ---- Team digests (preview/test only) ----------------------------------------------------------------------------
const deptFact = (day: string, source: Vendor, costType: CostType, costUsd: number, department: string, model = ""): ShapeFact => ({
  ...fact(day, source, costType, costUsd, null, model), department,
});
const teamFacts: ShapeFact[] = [
  // Engineering person-less Figma AI subscription (999) is in here. Sam is in Data Science, so his facts say so.
  ...facts.map((f) => (f.employeeId === "s" ? { ...f, department: "Data Science" } : f)),
  deptFact("2026-09-23", "openrouter", "metered", 5, "Engineering", "ws"), // department-attributed usage
  deptFact("2026-09-23", "openrouter", "metered", 77, "Data Science", "ws"), // another team's: never ours
];
const teamInput = (over: Partial<TeamDigestInput> = {}): TeamDigestInput => ({
  department: "Engineering", employeesById: byId, facts: teamFacts, period: periodFor("weekly", "2026-W39", now), now,
  sourceHorizons: {}, toolColors: {}, freshness: [], missingImports: [], baseUrl: "https://x.test", includeFixed: false, ...over,
});

describe("buildTeamDigest — weekly (usage basis)", () => {
  const d = buildTeamDigest(teamInput())!;

  it("counts members' usage (leavers included) plus person-less department usage, nothing from other teams", () => {
    // m 38.2 + a 140 + leaver 42 + dept 5; Sam (Data Science), the Data Science dept fact and monthly-level facts are out.
    expect(d.team).toMatchObject({ basis: "usage", headlineUsd: 225.2, prevUsd: 34.1 });
    expect(d.team.deltaPct).toBe(560.4);
    expect(d.team.byTool.map((t) => [t.key, t.usd])).toEqual([["cursor", 170.1], ["openrouter", 47], ["anthropic", 8.1]]);
  });

  it("names the department, links to its Explore page and lists the top people with the remainder as others", () => {
    expect(d).toMatchObject({ kind: "team", department: "Engineering", dashboardUrl: "https://x.test/explore/Engineering" });
    expect(d.team.top.map((p) => [p.name, p.usd])).toEqual([["Alex Kim", 140], ["Former Person", 42], ["Priya Nair", 38.2]]);
    expect(d.team.top[0].href).toBe("https://x.test/explore/Engineering/a");
    // the department-level $5 has no person: it is the remainder (so top + others is the headline) and team-level spend
    expect(d.team).toMatchObject({ othersCount: 0, othersUsd: 5, teamLevelUsd: 5 });
  });

  it("headcount is active members only, even though a leaver's spend counts", () => {
    expect(d.team.headcount).toBe(3); // m, a, n — not the leaver, not Sam
  });

  it("month context is on the same basis: usage incl. Claude Team's lump, no seat or department subscription", () => {
    // m 72.3 + a (140 + 500 lump) + leaver 42 + dept usage 5
    expect(d.team.month).toMatchObject({ monthLabel: "September", soFarUsd: 759.3, complete: false });
    // with fixed costs: + m's seat 40 + Figma AI 999
    expect(buildTeamDigest(teamInput({ includeFixed: true }))!.team.month).toMatchObject({ soFarUsd: 1798.3 });
  });

  it("charts 8 weekly buckets on the same basis", () => {
    expect(d.team.chart).toHaveLength(8);
    expect(d.team.chart[7]).toMatchObject({ current: true, totalUsd: 225.2 });
    expect(d.team.chart[6]).toMatchObject({ current: false, totalUsd: 34.1 });
  });

  it("encodes the department in the dashboard link", () => {
    expect(buildTeamDigest(teamInput({ department: "R&D Ops" }))!.dashboardUrl).toBe("https://x.test/explore/R%26D%20Ops");
  });
});

describe("buildTeamDigest — monthly (total basis)", () => {
  it("monthly total is the sum of the team's facts to the cent, including the department's recurring cost", () => {
    const aug: ShapeFact[] = [
      fact("2026-08-01", "cursor", "seat", 40, "m"),
      fact("2026-08-10", "cursor", "overage", 20.05, "m"),
      fact("2026-08-12", "openrouter", "metered", 7.77, "l"), // leaver
      deptFact("2026-08-05", "other", "subscription", 100.1, "Engineering", "Figma AI"),
      { ...fact("2026-08-03", "cursor", "overage", 55, "s"), department: "Data Science" }, // Data Science member
      deptFact("2026-08-04", "other", "subscription", 33, "Data Science", "Notion"),
      fact("2026-07-03", "cursor", "overage", 7, "m"),
    ];
    const d = buildTeamDigest(teamInput({ facts: aug, period: periodFor("monthly", "2026-08", now), includeFixed: true }))!;
    expect(d.team).toMatchObject({ basis: "total", headlineUsd: 167.92, prevUsd: 7, month: null });
    expect(d.team.byTool.map((t) => [t.key, t.usd])).toEqual([["other:Figma AI", 100.1], ["cursor", 60.05], ["openrouter", 7.77]]);
    // top people exclude the person-less subscription; it is part of the remainder
    expect(d.team.top.map((p) => [p.name, p.usd])).toEqual([["Priya Nair", 60.05], ["Former Person", 7.77]]);
    expect(d.team).toMatchObject({ othersCount: 0, othersUsd: 100.1, teamLevelUsd: 100.1 });
  });

  it("a $999 department subscription is team-level spend, kept out of the people", () => {
    const aug: ShapeFact[] = [fact("2026-08-10", "cursor", "overage", 20, "m"), deptFact("2026-08-05", "other", "subscription", 999, "Engineering", "Figma AI")];
    const t = buildTeamDigest(teamInput({ facts: aug, period: periodFor("monthly", "2026-08", now), includeFixed: true }))!.team;
    expect(t).toMatchObject({ headlineUsd: 1019, teamLevelUsd: 999, othersCount: 0 });
    expect(t.top.map((p) => [p.name, p.usd])).toEqual([["Priya Nair", 20]]);
  });

  it("with fixed costs excluded, the department subscription drops out entirely", () => {
    const aug: ShapeFact[] = [fact("2026-08-10", "cursor", "overage", 20, "m"), deptFact("2026-08-05", "other", "subscription", 999, "Engineering", "Figma AI")];
    const t = buildTeamDigest(teamInput({ facts: aug, period: periodFor("monthly", "2026-08", now), includeFixed: false }))!.team;
    expect(t).toMatchObject({ basis: "usage", headlineUsd: 20, teamLevelUsd: 0 });
  });
});

describe("buildTeamDigest — daily", () => {
  it("is null when the team had no usage that day, even though a department subscription exists", () => {
    expect(buildTeamDigest(teamInput({ period: periodFor("daily", "2026-09-26", now) }))).toBeNull();
    // 24 Sep: Alex's $140 usage, plus the (monthly-level, therefore ignored) $999 subscription
    expect(buildTeamDigest(teamInput({ period: periodFor("daily", "2026-09-24", now) }))!.team.headlineUsd).toBe(140);
    // the department-level usage alone is still usage
    expect(buildTeamDigest(teamInput({ period: periodFor("daily", "2026-09-23", now) }))!.team.headlineUsd).toBe(13.1);
  });
});

describe("isTeamDigest", () => {
  it("tells the two digest kinds apart", () => {
    expect(isTeamDigest(buildTeamDigest(teamInput())!)).toBe(true);
    expect(isTeamDigest(buildDigest(input())!)).toBe(false);
  });
});

describe("buildTeamDigest — edge cases", () => {
  it("top 5 + others equal the headline to the cent with fractional amounts (≥7 members)", () => {
    const amounts = [10.333, 9.334, 8.334, 7.127, 6.334, 5.334, 4.334, 2.226];
    const many = amounts.map((_, i) => emp(`o${i}`, `Ops Person ${i}`, { department: "Ops" }));
    const f = [
      ...many.map((p, i) => ({ ...fact("2026-09-22", "cursor", "overage", amounts[i], p.id), department: "Ops" })),
      deptFact("2026-09-23", "openrouter", "metered", 3.337, "Ops", "ws"),
    ];
    const map = new Map([...byId, ...many.map((p) => [p.id, p] as const)]);
    const t = buildTeamDigest(teamInput({ department: "Ops", facts: f, employeesById: map }))!.team;
    expect(t.top).toHaveLength(5);
    expect(t.othersCount).toBe(3);
    expect(t.headcount).toBe(8);
    const cents = (n: number) => Math.round(n * 100);
    expect(cents(t.top.reduce((s, p) => s + p.usd, 0) + t.othersUsd)).toBe(cents(t.headlineUsd));
  });

  it("counts a fact tagged with this department even when its person sits in another one (Explore's rule): total and team-level, never named", () => {
    const f = [...teamFacts, { ...fact("2026-09-23", "cursor", "overage", 25, "s"), department: "Engineering" }];
    const t = buildTeamDigest(teamInput({ facts: f }))!.team;
    expect(t.headlineUsd).toBe(250.2); // 225.2 + 25
    expect(t.teamLevelUsd).toBe(30); // the department's own $5 + Sam's $25 tagged to Engineering
    expect(t.top.map((p) => p.name)).toEqual(["Alex Kim", "Former Person", "Priya Nair"]); // Sam is not a member
    expect(t.headcount).toBe(3);
  });

  it("other departments' people are neither counted nor named; a member's fact tagged elsewhere still belongs to the member", () => {
    const f = [{ ...fact("2026-09-23", "cursor", "overage", 7, "m"), department: "Data Science" }];
    const t = buildTeamDigest(teamInput({ facts: f }))!.team;
    expect(t).toMatchObject({ headlineUsd: 7, teamLevelUsd: 0 });
    expect(t.top.map((p) => [p.name, p.usd])).toEqual([["Priya Nair", 7]]);
    expect(buildTeamDigest(teamInput({ department: "Data Science", facts: f }))!.team.headlineUsd).toBe(7); // and it is Data Science's by tag too
  });

  it("splits the remainder: 7 people + a $50 department cost leave others = the 2 people, team-level = $50", () => {
    const amounts = [100, 90, 80, 70, 60, 11, 10];
    const many = amounts.map((_, i) => emp(`p${i}`, `Ops Person ${i}`, { department: "Ops" }));
    const f = [
      ...many.map((p, i) => ({ ...fact("2026-09-22", "cursor", "overage", amounts[i], p.id), department: "Ops" })),
      deptFact("2026-09-23", "openrouter", "metered", 50, "Ops", "ws"),
    ];
    const map = new Map([...byId, ...many.map((p) => [p.id, p] as const)]);
    const t = buildTeamDigest(teamInput({ department: "Ops", facts: f, employeesById: map }))!.team;
    expect(t).toMatchObject({ headlineUsd: 471, othersCount: 2, othersUsd: 71, teamLevelUsd: 50 });
  });

  it("rounding cents alone leave no team-level spend (3 members at $1.004)", () => {
    const many = [0, 1, 2].map((i) => emp(`c${i}`, `Cent Person ${i}`, { department: "Ops" }));
    const f = many.map((p) => ({ ...fact("2026-09-22", "cursor", "overage", 1.004, p.id), department: "Ops" }));
    const map = new Map([...byId, ...many.map((p) => [p.id, p] as const)]);
    const t = buildTeamDigest(teamInput({ department: "Ops", facts: f, employeesById: map }))!.team;
    expect(t.teamLevelUsd).toBe(0);
    expect(t.othersCount).toBe(0);
    expect(t.othersUsd).toBe(0.01); // 3.01 headline − 3 × $1.00: a rounding leftover the renderer must not show
  });

  it("caveats mention only sources the team used on the headline basis", () => {
    const d = buildTeamDigest(teamInput({
      freshness: [
        { source: "cursor", lastSyncFailed: true, lastSuccessDay: "2026-09-29" },
        { source: "openai", lastSyncFailed: true, lastSuccessDay: "2026-09-29" },
      ],
    }))!;
    expect(d.caveats).toEqual(["⚠ Cursor data may be incomplete (last synced 29 Sep)"]);
  });

  it("an unknown or empty team still yields a valid $0 digest on a non-daily cadence", () => {
    const d = buildTeamDigest(teamInput({ department: "Nobody Here" }))!;
    expect(d.team).toMatchObject({ headlineUsd: 0, headcount: 0, top: [], othersCount: 0, othersUsd: 0 });
  });
});
