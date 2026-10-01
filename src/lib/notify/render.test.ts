import { describe, expect, it } from "vitest";
import type { Digest, DigestSection, TeamDigest } from "./digest";
import { chartTitle, deltaText, escapeMrkdwn, renderDigest, renderTeamDigest, teamChartTitle } from "./render";
import { periodFor } from "./schedule";

const now = new Date("2026-09-30T07:00:00Z");
const sec = (over: Partial<DigestSection> = {}): DigestSection => ({
  basis: "usage", headlineUsd: 38.2, prevUsd: 34.1, deltaPct: 12, chart: [], chartTools: [],
  byTool: [{ key: "cursor", label: "Cursor", color: "#f59e0b", usd: 30.1 }, { key: "anthropic", label: "Anthropic API", color: "#d2845a", usd: 8.1 }],
  month: { monthLabel: "September", soFarUsd: 142, projectedUsd: 190, complete: false }, ...over,
});
const digest = (over: Partial<Digest> = {}): Digest => ({
  recipient: { employeeId: "m", name: "Priya Nair", team: "Engineering" },
  period: periodFor("weekly", "2026-W39", now),
  you: sec(),
  reports: {
    ...sec({ headlineUsd: 612, prevUsd: 640, deltaPct: -4.4, month: { monthLabel: "September", soFarUsd: 3410, projectedUsd: 4600, complete: false } }),
    headcount: 14,
    top: [
      { employeeId: "a", name: "Alex Kim", usd: 140, href: "https://x.test/explore/Engineering/a" },
      { employeeId: "t", name: "Tom & <Jerry>", usd: 96, href: "https://x.test/explore/Engineering/t" },
    ],
    othersCount: 9, othersUsd: 175,
  },
  caveats: ["⚠ Cursor data may be incomplete (last synced 26 Sep)"],
  dashboardUrl: "https://x.test/explore/Engineering/m",
  ...over,
});
const mrk = (b: Record<string, unknown>) => (b.text as { text: string }).text;

describe("renderDigest", () => {
  const { blocks, text } = renderDigest(digest(), { you: "F1", reports: "F2" });

  it("leads with a header naming the period", () => {
    expect(blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "📊 Your AI spend · 21–27 Sep 2026", emoji: true } });
  });

  it("renders the You section: headline, its own chart, tools + month line", () => {
    expect(mrk(blocks[1])).toBe("*YOU*\n*$38.20* usage · ▲ 12% vs previous week");
    expect(blocks[2]).toEqual({ type: "image", slack_file: { id: "F1" }, alt_text: "YOU · USAGE, LAST 8 WEEKS: $38.20" });
    expect(blocks[3]).toEqual({ type: "context", elements: [
      { type: "mrkdwn", text: "Cursor $30.10 · Anthropic API $8.10" },
      { type: "mrkdwn", text: "September so far $142 · on track for ~$190" },
    ] });
  });

  it("renders the reports section with escaped, linked names and others", () => {
    const i = blocks.findIndex((b) => b.type === "section" && mrk(b).startsWith("*YOUR REPORTS"));
    expect(mrk(blocks[i])).toBe("*YOUR REPORTS · 14 PEOPLE*\n*$612* usage · ▼ 4% vs previous week");
    expect(blocks[i + 1]).toMatchObject({ type: "image", slack_file: { id: "F2" } });
    expect(mrk(blocks[i + 2])).toBe(
      "<https://x.test/explore/Engineering/a|Alex Kim> $140 · <https://x.test/explore/Engineering/t|Tom &amp; &lt;Jerry&gt;> $96.00 · +9 others $175",
    );
  });

  it("ends with caveats and an Open in dashboard button", () => {
    expect(blocks.at(-2)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "⚠ Cursor data may be incomplete (last synced 26 Sep)" }] });
    expect(blocks.at(-1)).toMatchObject({ type: "actions", elements: [{ type: "button", url: "https://x.test/explore/Engineering/m" }] });
  });

  it("has a plain-text fallback carrying every headline figure", () => {
    expect(text).toContain("$38.20");
    expect(text).toContain("$612");
    expect(text).toContain("21–27 Sep 2026");
  });

  it("omits image blocks when no chart was uploaded", () => {
    expect(renderDigest(digest(), {}).blocks.some((b) => b.type === "image")).toBe(false);
  });

  it("prefixes preview messages with who it would have gone to", () => {
    const first = renderDigest(digest(), {}, { previewFor: "Priya Nair (weekly)" }).blocks[0];
    expect(first).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "🔍 Preview · would send to Priya Nair (weekly)" }] });
  });

  it("puts a banner first as an escaped context block and prefixes the plain-text fallback", () => {
    const r = renderDigest(digest(), { you: "F1" }, { banner: "🧪 Test: Tom & <Jerry>'s weekly digest, sent to you by Admin" });
    expect(r.blocks[0]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "🧪 Test: Tom &amp; &lt;Jerry&gt;'s weekly digest, sent to you by Admin" }] });
    expect(r.blocks[1]).toMatchObject({ type: "header" });
    expect(r.text.startsWith("[🧪 Test: Tom & <Jerry>'s weekly digest, sent to you by Admin] Your AI spend · ")).toBe(true);
  });

  it("is unchanged without a banner", () => {
    expect(renderDigest(digest(), {}).blocks[0]).toMatchObject({ type: "header" });
    expect(renderDigest(digest(), {}).text.startsWith("Your AI spend")).toBe(true);
  });

  it("keeps the cron's preview line and its text prefix exactly", () => {
    const r = renderDigest(digest(), {}, { previewFor: "Priya Nair (weekly)" });
    expect(r.blocks[0]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "🔍 Preview · would send to Priya Nair (weekly)" }] });
    expect(r.blocks.slice(1)).toEqual(renderDigest(digest(), {}).blocks);
    expect(r.text.startsWith("[Preview for Priya Nair (weekly)] Your AI spend")).toBe(true);
  });

  it("people without reports get no reports section", () => {
    const b = renderDigest(digest({ reports: null }), {}).blocks;
    expect(b.some((x) => x.type === "section" && mrk(x).includes("REPORTS"))).toBe(false);
  });
});

const teamDigest = (over: Partial<TeamDigest> = {}): TeamDigest => ({
  kind: "team",
  department: "R&D <Ops>",
  period: periodFor("weekly", "2026-W39", now),
  team: {
    ...sec({ headlineUsd: 612, prevUsd: 640, deltaPct: -4.4, month: { monthLabel: "September", soFarUsd: 3410, projectedUsd: 4600, complete: false } }),
    headcount: 14,
    top: [
      { employeeId: "a", name: "Alex Kim", usd: 140, href: "https://x.test/explore/R%26D/a" },
      { employeeId: "t", name: "Tom & <Jerry>", usd: 96, href: "https://x.test/explore/R%26D/t" },
    ],
    othersCount: 9, othersUsd: 175,
  },
  caveats: ["⚠ Cursor data may be incomplete (last synced 26 Sep)"],
  dashboardUrl: "https://x.test/explore/R%26D%20%3COps%3E",
  ...over,
});

describe("renderTeamDigest", () => {
  const { blocks, text } = renderTeamDigest(teamDigest(), { team: "F1" });

  it("leads with a header naming the department and period (plain text: not escaped)", () => {
    expect(blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "📊 AI spend · R&D <Ops> · 21–27 Sep 2026", emoji: true } });
  });

  it("labels the section with the escaped, uppercased department and the headcount", () => {
    expect(mrk(blocks[1])).toBe("*R&amp;D &lt;OPS&gt; · 14 PEOPLE*\n*$612* usage · ▼ 4% vs previous week");
    expect(renderTeamDigest(teamDigest({ team: { ...teamDigest().team, headcount: 1 } }), {}).blocks[1]).toMatchObject({
      text: { text: expect.stringContaining("· 1 PERSON*") },
    });
  });

  it("shows the chart, the linked escaped top people with the remainder, then tools and month lines", () => {
    expect(blocks[2]).toEqual({ type: "image", slack_file: { id: "F1" }, alt_text: "R&D <OPS> (14 PEOPLE) · USAGE, LAST 8 WEEKS: $612" });
    expect(mrk(blocks[3])).toBe(
      "<https://x.test/explore/R%26D/a|Alex Kim> $140 · <https://x.test/explore/R%26D/t|Tom &amp; &lt;Jerry&gt;> $96.00 · +9 others $175",
    );
    expect(blocks[4]).toEqual({ type: "context", elements: [
      { type: "mrkdwn", text: "Cursor $30.10 · Anthropic API $8.10" },
      { type: "mrkdwn", text: "September so far $3,410 · on track for ~$4,600" },
    ] });
  });

  it("ends with caveats and an Open in dashboard button on the team page", () => {
    expect(blocks.at(-2)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "⚠ Cursor data may be incomplete (last synced 26 Sep)" }] });
    expect(blocks.at(-1)).toEqual({
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "Open in dashboard" }, url: "https://x.test/explore/R%26D%20%3COps%3E", action_id: "open_dashboard" }],
    });
  });

  it("has a plain-text fallback carrying the headline figure", () => {
    expect(text).toBe("AI spend · R&D <Ops> · 21–27 Sep 2026: team $612 usage");
  });

  it("omits the image block when no chart was uploaded", () => {
    expect(renderTeamDigest(teamDigest(), {}).blocks.some((b) => b.type === "image")).toBe(false);
  });

  it("does not leave the department-level remainder unexplained when everyone is listed", () => {
    const t = teamDigest();
    const line = mrk(renderTeamDigest(teamDigest({ team: { ...t.team, othersCount: 0, othersUsd: 5 } }), {}).blocks[2]);
    expect(line.endsWith(" · +team-level costs $5.00")).toBe(true);
    const none = renderTeamDigest(teamDigest({ team: { ...t.team, top: [], othersCount: 0, othersUsd: 0 } }), {}).blocks[2];
    expect(mrk(none)).toBe("No usage from this team this week");
    const only = renderTeamDigest(teamDigest({ team: { ...t.team, top: [], othersCount: 0, othersUsd: 5 } }), {}).blocks[2];
    expect(mrk(only)).toBe("team-level costs $5.00");
  });

  it("puts a banner first and prefixes the text fallback", () => {
    const r = renderTeamDigest(teamDigest(), {}, { banner: "🧪 Test: R&D <Ops>'s weekly digest, sent to you by Admin" });
    expect(r.blocks[0]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "🧪 Test: R&amp;D &lt;Ops&gt;'s weekly digest, sent to you by Admin" }] });
    expect(r.blocks[1]).toMatchObject({ type: "header" });
    expect(r.text.startsWith("[🧪 Test: R&D <Ops>'s weekly digest, sent to you by Admin] AI spend · ")).toBe(true);
  });
});

describe("teamChartTitle", () => {
  it("names the department, headcount, basis and span in capitals", () => {
    expect(teamChartTitle(teamDigest())).toBe("R&D <OPS> (14 PEOPLE) · USAGE, LAST 8 WEEKS");
    const monthly = teamDigest({ period: periodFor("monthly", "2026-08", now), team: { ...teamDigest().team, basis: "total", month: null, headcount: 1 } });
    expect(teamChartTitle(monthly)).toBe("R&D <OPS> (1 PERSON) · TOTAL, LAST 6 MONTHS");
    const daily = teamDigest({ period: periodFor("daily", "2026-09-24", now) });
    expect(teamChartTitle(daily)).toBe("R&D <OPS> (14 PEOPLE) · USAGE, LAST 14 DAYS");
  });
});

describe("deltaText", () => {
  it("covers up, down, flat, from-zero and nothing-at-all", () => {
    expect(deltaText(sec({ deltaPct: 12 }), "week")).toBe("▲ 12% vs previous week");
    expect(deltaText(sec({ deltaPct: -4.4 }), "week")).toBe("▼ 4% vs previous week");
    expect(deltaText(sec({ deltaPct: 0.3 }), "day")).toBe("no change vs previous day");
    expect(deltaText(sec({ deltaPct: null, prevUsd: 0, headlineUsd: 5 }), "month")).toBe("up from $0 the previous month");
    expect(deltaText(sec({ deltaPct: null, prevUsd: 0, headlineUsd: 0 }), "week")).toBe("no spend");
  });
});

describe("chartTitle", () => {
  it("names the section, basis and span", () => {
    expect(chartTitle("you", digest())).toBe("YOU · USAGE, LAST 8 WEEKS");
    expect(chartTitle("reports", digest())).toBe("YOUR REPORTS (14 PEOPLE) · USAGE, LAST 8 WEEKS");
    const monthly = digest({ period: periodFor("monthly", "2026-08", now), you: sec({ basis: "total", month: null }) });
    expect(chartTitle("you", monthly)).toBe("YOU · TOTAL, LAST 6 MONTHS");
  });
});

describe("escapeMrkdwn", () => {
  it("escapes the three characters Slack treats as control", () => {
    expect(escapeMrkdwn("Tom & <Jerry>")).toBe("Tom &amp; &lt;Jerry&gt;");
  });
});
