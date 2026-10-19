import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import { VENDOR_LABEL, type CostType, type Vendor } from "@/lib/types";
import { buildCompanyDigest, buildDigest, buildTeamDigest, isCompanyDigest, isTeamDigest, round2, type DigestInput, type SectionInput, type TeamDigestInput } from "./digest";
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

describe("month line with a month-to-date paste", () => {
  it("projects Claude Team's paste at its pace when the as-of day is known", () => {
    const sep = [fact("2026-09-01", "claude_team", "overage", 300, "m")];
    const d = buildDigest(input({ facts: sep, reportIds: [], snapshotAsOf: { "claude_team:2026-09": "2026-09-10" } }));
    // weekly: the paste isn't in the headline, but the month line projects it: $30/day × 30
    expect(d?.you.month?.projectedUsd ?? null).toBeCloseTo(900, 0);
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

  it("tells the company report apart from both", () => {
    const company = buildCompanyDigest(input())!;
    expect(isCompanyDigest(company)).toBe(true);
    expect(isTeamDigest(company)).toBe(false);
    expect(isCompanyDigest(buildDigest(input())!)).toBe(false);
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

describe("buildCompanyDigest", () => {
  const nowOct = new Date("2026-10-08T07:00:00Z");
  const f = (day: string, source: Vendor, costType: CostType, costUsd: number, employeeId: string | null, department: string | null, model = ""): ShapeFact => ({
    day, source, costType, costUsd, employeeId, department, fullName: null, entityKey: employeeId ?? "org", model,
  });
  const coFacts: ShapeFact[] = [
    f("2026-09-22", "cursor", "overage", 30, "m", "Engineering"),
    f("2026-09-24", "cursor", "overage", 140, "a", "Engineering"),
    f("2026-09-25", "anthropic", "metered", 96, "s", "Data Science"),
    f("2026-09-21", "openrouter", "metered", 42, "l", "Engineering"), // a leaver's spend counts
    f("2026-09-23", "anthropic", "metered", 20, null, null), // unkeyed: no person, no team
    f("2026-09-23", "openrouter", "metered", 12, null, "Data Science"), // a workspace key: a team, no person
    f("2026-09-15", "cursor", "overage", 100, "m", "Engineering"), // previous week
    f("2026-09-01", "claude_team", "overage", 500, "a", "Engineering"), // Claude Team's monthly lump
    f("2026-08-01", "cursor", "seat", 310, "m", "Engineering"),
    f("2026-08-01", "other", "subscription", 90, null, "Engineering", "Figma AI"),
    f("2026-09-01", "cursor", "seat", 300, "m", "Engineering"),
    f("2026-09-01", "other", "subscription", 90, null, "Engineering", "Figma AI"),
  ];
  const coInput = (over: Partial<SectionInput> = {}): SectionInput => ({
    employeesById: byId, facts: coFacts, period: periodFor("weekly", "2026-W39", nowOct), now: nowOct, sourceHorizons: {}, toolColors: {},
    freshness: [], missingImports: [], baseUrl: "https://x.test", includeFixed: false, ...over,
  });
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const d = buildCompanyDigest(coInput())!;

  it("is usage only, company-wide: everyone's usage and usage tied to no one, against the previous week", () => {
    expect(d).toMatchObject({ kind: "company", dashboardUrl: "https://x.test/explore", totalUsd: null });
    expect(d.usage).toMatchObject({ basis: "usage", headlineUsd: 340, prevUsd: 100, headcount: 4 }); // 4 active; the leaver isn't headcount
  });

  it("ignores the fixed-costs setting: usage and seats & subscriptions are always apart", () => {
    expect(buildCompanyDigest(coInput({ includeFixed: true }))!.usage).toMatchObject({ basis: "usage", headlineUsd: 340 });
  });

  it("ranks teams as Explore does (the fact's department, else the person's), with no-team usage apart", () => {
    expect(d.usage.teams).toEqual([
      { department: "Engineering", usd: 212, href: "https://x.test/explore/Engineering" },
      { department: "Data Science", usd: 108, href: "https://x.test/explore/Data%20Science" },
    ]);
    expect(d.usage).toMatchObject({ otherTeamsCount: 0, otherTeamsUsd: 0, unattributedUsd: 20 });
  });

  it("ranks people company-wide; usage tied to no person stays out of the people", () => {
    expect(d.usage.top.map((p) => [p.name, p.usd])).toEqual([["Alex Kim", 140], ["Sam Lee", 96], ["Former Person", 42], ["Priya Nair", 30]]);
    expect(d.usage.top[1].href).toBe("https://x.test/explore/Data%20Science/s");
    expect(d.usage).toMatchObject({ othersCount: 0, othersUsd: 32, teamLevelUsd: 32 }); // $20 unkeyed + $12 workspace key
  });

  it("beyond the top five: +N teams and +N others, and every part adds up to the headline to the cent", () => {
    const many = Array.from({ length: 7 }, (_, i) => emp(`p${i}`, `Person ${i}`, { department: `T${i}` }));
    const facts7 = [...many.map((e, i) => f("2026-09-22", "cursor", "overage", 70.333 - i * 10, e.id, e.department)), f("2026-09-22", "anthropic", "metered", 5, null, null)];
    const u = buildCompanyDigest(coInput({ employeesById: new Map(many.map((e) => [e.id, e])), facts: facts7 }))!.usage;
    expect(u).toMatchObject({ otherTeamsCount: 2, othersCount: 2, unattributedUsd: 5, teamLevelUsd: 5 });
    expect(u.teams.map((t) => t.department)).toEqual(["T0", "T1", "T2", "T3", "T4"]);
    expect(round2(sum(u.teams.map((t) => t.usd)) + u.otherTeamsUsd + u.unattributedUsd)).toBe(u.headlineUsd);
    expect(round2(sum(u.top.map((p) => p.usd)) + u.othersUsd)).toBe(u.headlineUsd);
  });

  it("seats & subscriptions: a weekly is the week's share of the monthly bill, compared month on month", () => {
    // September's bill $390 ($300 seat + $90 subscription) over 30 days = $13/day; August's was $400
    expect(d.fixed).toMatchObject({ basis: "total", headlineUsd: 91, month: null, monthTotal: { label: "September", usd: 390, prevLabel: "August", prevUsd: 400, deltaPct: -2.5 } });
    expect(d.fixed.byTool.map((t) => [t.key, t.usd])).toEqual([["cursor", 70], ["other:Figma AI", 21]]);
  });

  it("a week spanning two months takes each month's share; the month line is the month the week ends in", () => {
    const oct = [...coFacts, f("2026-10-01", "cursor", "seat", 310, "m", "Engineering")];
    const w40 = buildCompanyDigest(coInput({ facts: oct, period: periodFor("weekly", "2026-W40", nowOct) }))!;
    expect(w40.fixed.headlineUsd).toBe(79); // Sep 28–30: 3 × $13; Oct 1–4: 4 × ($310 / 31)
    expect(w40.fixed.monthTotal).toEqual({ label: "October", usd: 310, prevLabel: "September", prevUsd: 390, deltaPct: -20.5 });
    expect(w40.usage.headlineUsd).toBe(0); // a weekly still goes out with no usage
  });

  it("the first month with fixed costs has nothing to compare with", () => {
    const first = buildCompanyDigest(coInput({ facts: coFacts.filter((x) => !x.day.startsWith("2026-08")) }))!;
    expect(first.fixed.monthTotal).toMatchObject({ usd: 390, prevUsd: 0, deltaPct: null });
  });

  it("a daily carries the day's share, and a day with no usage is no report, whatever the bill", () => {
    const fri = buildCompanyDigest(coInput({ period: periodFor("daily", "2026-09-25", nowOct) }))!;
    expect(fri.usage.headlineUsd).toBe(96);
    expect(fri.fixed.headlineUsd).toBe(13);
    expect(buildCompanyDigest(coInput({ period: periodFor("daily", "2026-09-28", nowOct) }))).toBeNull();
  });

  it("monthly: usage includes Claude Team's lump, the bill as posted vs last month, and a total of every fact in the month", () => {
    const sep = buildCompanyDigest(coInput({ period: periodFor("monthly", "2026-09", nowOct) }))!;
    expect(sep.usage.headlineUsd).toBe(940);
    expect(sep.fixed).toMatchObject({ headlineUsd: 390, prevUsd: 400, deltaPct: -2.5, monthTotal: null });
    expect(sep.totalUsd).toBe(1330);
    expect(sep.totalUsd).toBe(round2(sep.usage.headlineUsd + sep.fixed.headlineUsd));
  });

  it("caveats cover the sources used and the seats' sources, never a subscription's", () => {
    const stale = (source: Vendor) => ({ source, lastSyncFailed: true, lastSuccessDay: "2026-09-20" });
    const facts3 = [
      f("2026-09-23", "anthropic", "metered", 20, "m", "Engineering"),
      f("2026-09-01", "cursor", "seat", 300, "m", "Engineering"),
      f("2026-09-01", "openrouter", "subscription", 50, null, "Engineering", "platform fee"),
    ];
    const caveats = buildCompanyDigest(coInput({ facts: facts3, freshness: (["anthropic", "cursor", "openrouter", "openai"] as Vendor[]).map(stale) }))!.caveats;
    expect(caveats).toHaveLength(2);
    expect(caveats.join("\n")).toContain(VENDOR_LABEL.anthropic);
    expect(caveats.join("\n")).toContain(VENDOR_LABEL.cursor);
  });
});

describe("buildDigest — by-team breakdown for a manager of managers", () => {
  const team = [
    emp("boss", "Dana Boss", { department: "Leadership" }),
    emp("l1", "Alex Kim", { department: "Data Science" }),
    emp("l1a", "Ana One", { department: "Data Science" }),
    emp("l1b", "Ben Two", { department: "Data Science", employmentStatus: "deprovisioned", leaveDate: "2026-09-01" }),
    emp("l2", "Sam Lee", { department: "Engineering" }),
    emp("l2a", "Cal Three", { department: "Engineering" }),
    emp("ic", "Priya Shah", { department: null }),
    emp("quiet", "Quinn Quiet", { department: "Product" }),
  ];
  const map = new Map(team.map((p) => [p.id, p]));
  const f = [
    fact("2026-09-22", "cursor", "overage", 10, "l1"),
    fact("2026-09-22", "cursor", "overage", 20, "l1a"),
    fact("2026-09-23", "anthropic", "metered", 5, "l1b"), // a leaver's spend counts
    fact("2026-09-24", "cursor", "overage", 50, "l2a"),
    fact("2026-09-24", "cursor", "overage", 3, "ic"),
    fact("2026-09-10", "cursor", "overage", 999, "l2"), // outside the week
  ];
  const branches = [
    { leadId: "l1", memberIds: ["l1", "l1a", "l1b"] },
    { leadId: "l2", memberIds: ["l2", "l2a"] },
    { leadId: "ic", memberIds: ["ic"] },
    { leadId: "quiet", memberIds: ["quiet"] },
  ];
  const d = buildDigest(input({
    recipient: map.get("boss")!, employeesById: map, facts: f,
    reportIds: ["l1", "l1a", "l1b", "l2", "l2a", "ic", "quiet"], branches,
  }))!;

  it("lists each direct report's team, largest first, with active headcount; no spend, no line", () => {
    expect(d.reports!.branches!.map((b) => [b.team, b.name, b.headcount, b.usd])).toEqual([
      ["Engineering", "Sam Lee", 2, 50],
      ["Data Science", "Alex Kim", 2, 35],
      [null, "Priya Shah", 1, 3],
    ]);
    expect(d.reports!.branches![0].href).toBe("https://x.test/explore/Engineering/l2");
    expect(d.reports!.otherBranchesCount).toBe(0);
  });

  it("adds up to the section total", () => {
    expect(d.reports!.branches!.reduce((s, b) => s + b.usd, 0)).toBe(d.reports!.headlineUsd);
  });

  it("keeps the top six and sums the rest", () => {
    const leads = Array.from({ length: 8 }, (_, i) => emp(`d${i}`, `Lead ${i}`));
    const m2 = new Map([...team, ...leads].map((p) => [p.id, p]));
    const d2 = buildDigest(input({
      recipient: map.get("boss")!, employeesById: m2,
      facts: leads.map((l, i) => fact("2026-09-22", "cursor", "overage", 10 + i, l.id)),
      reportIds: leads.map((l) => l.id), branches: leads.map((l) => ({ leadId: l.id, memberIds: [l.id] })),
    }))!;
    expect(d2.reports!.branches!.map((b) => b.usd)).toEqual([17, 16, 15, 14, 13, 12]);
    expect(d2.reports).toMatchObject({ otherBranchesCount: 2, otherBranchesUsd: 21 });
  });

  it("is absent without branches (everyone who doesn't manage managers)", () => {
    expect(buildDigest(input())!.reports!.branches).toBeUndefined();
  });
});
