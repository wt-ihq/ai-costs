import { describe, expect, it } from "vitest";
import type { RecommendationsData } from "@/lib/recommendations/load";
import type { RecRow, RecToolResult } from "@/lib/recommendations/rule";
import { renderRecommendations, REC_LIST_MAX } from "./render-recommendations";

const row = (i: number, over: Partial<RecRow> = {}): RecRow => ({
  employeeId: `e${i}`, name: `Person ${i}`, department: "Engineering", tierUnknown: false, extraUsd: 200, savingUsd: 500 - i,
  weeks: [], pattern: "steady", newThisWeek: false, ...over,
});
const cursorRows = [
  row(0, { name: "Tom Okafor", savingUsd: 951 }),
  row(1, { newThisWeek: true, pattern: "recent", department: null }),
  ...Array.from({ length: 13 }, (_, i) => row(i + 2)),
];
const tool = (t: RecToolResult["tool"], rows: RecRow[], stepUpUsd: number): RecToolResult => ({
  tool: t, stepUpUsd, rows, premiumCount: 3, totalSavingUsd: rows.reduce((s, r) => s + r.savingUsd, 0),
});
const base: RecommendationsData = {
  sunday: "2026-11-08", weeks: [], readiness: { ready: true, outstanding: [] }, rosterAsOf: { cursor: "2026-11-03" },
  cursorRosterStale: false, departments: [], updatedAt: "2026-11-09T09:00:00Z",
  tools: [tool("cursor", cursorRows, 80), tool("claude_team", [row(20)], 100), tool("chatgpt_business", [], 30)],
};
const text = (r: { blocks: unknown[] }) => JSON.stringify(r.blocks);

describe("renderRecommendations", () => {
  it("renders the full list by tool with amounts first and a tracked button", () => {
    const r = renderRecommendations({ data: base, dashboardUrl: "https://x/recommendations", openUrl: "https://x/api/digest/open/abc", links: true });
    expect(r.blocks[0]).toMatchObject({ type: "header", text: { text: ":ai-spend: Premium seat recommendations · four weeks to Sunday 8 November" } });
    const s = text(r);
    expect(s).toContain("• *$951* Tom Okafor, Engineering · steady");
    expect(s).toContain("• *$499* Person 1, Unattributed · recent · new this week");
    expect(s).toContain("*Cursor · 15 people · Standard → Premium is +$80 a month*");
    expect(s).toContain("*Claude Team · 1 person · Standard → Premium is +$100 a month*");
    expect(s).toContain("*ChatGPT · nobody over the line*");
    expect(s).toContain("… and 5 more");
    expect(s).toContain("People on a Standard seat whose extra spend over the last four weeks was more than the step up to Premium.");
    expect(s).toContain("16 people, $");
    expect(s).toContain("potential saving a month.");
    expect(s).toContain("Seat tiers from the latest rosters (Cursor export 3 Nov).");
    expect(r.blocks.at(-1)).toMatchObject({ type: "actions", elements: [{ text: { text: "Open recommendations" }, url: "https://x/api/digest/open/abc" }] });
    expect(r.text).toMatch(/^Premium seat recommendations: 16 people, \$[\d,]+ potential saving a month$/);
    expect(REC_LIST_MAX).toBe(10);
  });

  it("uses the dashboard url without an open url, and no button when links are off", () => {
    const a = renderRecommendations({ data: base, dashboardUrl: "https://x/recommendations", links: true });
    expect(a.blocks.at(-1)).toMatchObject({ elements: [{ url: "https://x/recommendations" }] });
    const b = renderRecommendations({ data: base, dashboardUrl: "https://x/recommendations", links: false });
    expect(b.blocks.some((x) => x.type === "actions")).toBe(false);
  });

  it("renders the two-block empty message", () => {
    const empty = { ...base, tools: base.tools.map((t) => ({ ...t, rows: [], totalSavingUsd: 0 })) };
    const r = renderRecommendations({ data: empty, dashboardUrl: "u", links: false });
    expect(r.blocks).toHaveLength(2);
    expect(text(r)).toContain("Nobody on a Standard seat is over the line this week");
  });

  it("warns when the Cursor roster is stale or missing", () => {
    const stale = renderRecommendations({ data: { ...base, cursorRosterStale: true, rosterAsOf: { cursor: "2026-09-01" } }, dashboardUrl: "u", links: false });
    expect(text(stale)).toContain("Cursor seat tiers from 1 Sep — upload a newer members export.");
    expect(text(stale)).not.toContain("Seat tiers from the latest rosters");
    const none = renderRecommendations({ data: { ...base, cursorRosterStale: true, rosterAsOf: {} }, dashboardUrl: "u", links: false });
    expect(text(none)).toContain("No Cursor members export uploaded yet.");
  });

  it("escapes names and prepends the preview context", () => {
    const data = { ...base, tools: [tool("cursor", [row(0, { name: "A & <B>" })], 80)] };
    const r = renderRecommendations({ data, dashboardUrl: "u", links: false, previewFor: "Priya Nair" });
    expect(r.blocks[0]).toMatchObject({ type: "context", elements: [{ text: "Preview for *Priya Nair*" }] });
    expect(r.blocks[1]).toMatchObject({ type: "header" });
    expect(text(r)).toContain("A &amp; &lt;B&gt;");
  });
});
