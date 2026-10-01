import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import { chartLayoutsFor, chartLayoutsForTeam, deliverDigest, deliverTeamDigest, PostOutcomeUnknownError } from "./deliver";
import { buildDigest, buildTeamDigest } from "./digest";
import { periodFor } from "./schedule";
import { SlackApiError, type SlackClient } from "./slack-client";
import type { NotifyEmployee } from "./types";

const now = new Date("2026-09-30T07:00:00Z");
const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: `Person ${id}`, department: "R&D", oktaId: null, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
const people = [emp("a"), emp("b")];
const fact = (usd: number, employeeId: string): ShapeFact => ({
  day: "2026-09-22", source: "cursor", costType: "overage", costUsd: usd, employeeId, department: "R&D", fullName: null, entityKey: employeeId, model: "",
});
const base = {
  employeesById: new Map(people.map((p) => [p.id, p])), facts: [fact(30, "a"), fact(12, "b")], period: periodFor("weekly", "2026-W39", now), now,
  sourceHorizons: {}, toolColors: {}, freshness: [], missingImports: [], baseUrl: "https://x.test",
};
const teamDigest = buildTeamDigest({ ...base, department: "R&D" })!;
const personDigest = buildDigest({ ...base, recipient: people[0], reportIds: ["b"] })!;

function fakeSlack(over: Partial<SlackClient> = {}) {
  const posts: { channel: string; blocks: unknown[]; text: string }[] = [];
  const uploads: { name: string; title: string }[] = [];
  const client: SlackClient = {
    lookupUserByEmail: async () => null,
    openDm: async (u) => `D-${u}`,
    uploadImage: async (_png, name, title) => {
      uploads.push({ name, title });
      return `F${uploads.length}`;
    },
    postMessage: async (channel, blocks, text) => {
      posts.push({ channel, blocks, text });
      return `ts${posts.length}`;
    },
    ...over,
  };
  return { client, posts, uploads };
}
const png = async () => new Uint8Array([1]) as Uint8Array<ArrayBuffer>;
const hasImage = (blocks: unknown[]) => blocks.some((b) => (b as { type: string }).type === "image");
const args = (slack: SlackClient, over: Record<string, unknown> = {}) => ({
  slack, renderChart: png, slackUserId: "U1", log: () => {}, sleep: async () => {}, ...over,
});

describe("chartLayoutsForTeam", () => {
  it("is one chart titled with the team, its headcount and basis", () => {
    const l = chartLayoutsForTeam(teamDigest);
    expect(Object.keys(l)).toEqual(["team"]);
    expect(l.team.title).toBe("R&D (2 PEOPLE) · USAGE, LAST 8 WEEKS");
    expect(l.team.bars).toHaveLength(8);
  });
});

describe("deliverTeamDigest", () => {
  it("uploads the team chart, DMs the digest with the image and the banner, and returns the ts", async () => {
    const s = fakeSlack();
    const ts = await deliverTeamDigest({ ...args(s.client), digest: teamDigest, banner: "🧪 Test: R&D's weekly digest, sent to you by Admin" });
    expect(ts).toBe("ts1");
    expect(s.uploads).toEqual([{ name: "ai-spend-team.png", title: "R&D (2 PEOPLE) · USAGE, LAST 8 WEEKS" }]);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].channel).toBe("D-U1");
    expect(s.posts[0].blocks[0]).toMatchObject({ type: "context" });
    expect(s.posts[0].blocks.find((b) => (b as { type: string }).type === "image")).toMatchObject({ slack_file: { id: "F1" } });
    expect(s.posts[0].text.startsWith("[🧪 Test: R&D's weekly digest, sent to you by Admin] AI spend · R&D")).toBe(true);
  });

  it("sends text-only when the chart cannot be rendered", async () => {
    const s = fakeSlack();
    const logs: string[] = [];
    await deliverTeamDigest({ ...args(s.client, { renderChart: async () => { throw new Error("satori"); }, log: (m: string) => logs.push(m) }), digest: teamDigest });
    expect(hasImage(s.posts[0].blocks)).toBe(false);
    expect(logs).toEqual(["[notify] chart team skipped: satori"]);
  });

  it("retries the image blocks once after a pause, then falls back to text only", async () => {
    const posts: unknown[][] = [];
    const slack = fakeSlack({
      postMessage: async (_c, blocks) => {
        posts.push(blocks);
        if (hasImage(blocks)) throw new SlackApiError("chat.postMessage", "invalid_blocks");
        return "ts";
      },
    });
    const waits: number[] = [];
    await deliverTeamDigest({ ...args(slack.client, { sleep: async (ms: number) => { waits.push(ms); } }), digest: teamDigest });
    expect(posts.map(hasImage)).toEqual([true, true, false]);
    expect(waits).toEqual([1500]);
  });

  it("does not retry a definitive rejection", async () => {
    let n = 0;
    const slack = fakeSlack({ postMessage: async () => { n++; throw new SlackApiError("chat.postMessage", "channel_not_found"); } });
    await expect(deliverTeamDigest({ ...args(slack.client), digest: teamDigest })).rejects.toMatchObject({ code: "channel_not_found" });
    expect(n).toBe(1);
  });

  it("reports an ambiguous failure as outcome-unknown", async () => {
    const slack = fakeSlack({ postMessage: async () => { throw new SlackApiError("chat.postMessage", "internal_error"); } });
    await expect(deliverTeamDigest({ ...args(slack.client), digest: teamDigest })).rejects.toBeInstanceOf(PostOutcomeUnknownError);
  });
});

describe("deliverDigest", () => {
  it("still uploads one chart per section under the original file names", async () => {
    const s = fakeSlack();
    await deliverDigest({ ...args(s.client), digest: personDigest });
    expect(s.uploads.map((u) => u.name)).toEqual(Object.keys(chartLayoutsFor(personDigest)).map((k) => `ai-spend-${k}.png`));
    expect(s.uploads.map((u) => u.name)).toEqual(["ai-spend-you.png", "ai-spend-reports.png"]);
  });

  it("passes a banner through to the message", async () => {
    const s = fakeSlack();
    await deliverDigest({ ...args(s.client), digest: personDigest, banner: "🧪 Test message from Admin — not a scheduled digest" });
    expect(s.posts[0].blocks[0]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "🧪 Test message from Admin — not a scheduled digest" }] });
    expect(s.posts[0].text.startsWith("[🧪 Test message from Admin — not a scheduled digest] Your AI spend")).toBe(true);
  });
});
