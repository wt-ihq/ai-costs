import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import { chartLayoutsFor, chartLayoutsForTeam, deliverDigest, deliverTeamDigest, PostOutcomeUnknownError, resolveSlackUser, SLACK_USER_TTL_MS } from "./deliver";
import { memoryStore } from "./memory-store";
import { buildDigest, buildTeamDigest } from "./digest";
import { chartHeadline } from "./render";
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
    expect(l.team.title).toBe("R&D (2 PEOPLE) · USAGE, 21–27 SEP 2026");
    expect(l.team.caption).toBe("LAST 8 WEEKS");
    expect(l.team.bars).toHaveLength(8);
  });
});

describe("chart headlines", () => {
  it("draw each section's own total and change into its chart", () => {
    const l = chartLayoutsFor(personDigest);
    expect(l.you.headline).toEqual(chartHeadline(personDigest.you, "previous week"));
    expect(l.reports?.headline).toEqual(chartHeadline(personDigest.reports!, "previous week"));
    expect([l.you.caption, l.reports?.caption]).toEqual(["LAST 8 WEEKS", "LAST 8 WEEKS"]);
    expect(chartLayoutsForTeam(teamDigest).team.headline).toEqual(chartHeadline(teamDigest.team, "previous week"));
  });
});

describe("deliverTeamDigest", () => {
  it("uploads the team chart, DMs the digest with the image and the banner, and returns the ts", async () => {
    const s = fakeSlack();
    const ts = await deliverTeamDigest({ ...args(s.client), digest: teamDigest, banner: "🧪 Test: R&D's weekly digest, sent to you by Admin" });
    expect(ts).toBe("ts1");
    expect(s.uploads).toEqual([{ name: "ai-spend-team.png", title: "R&D (2 PEOPLE) · USAGE, 21–27 SEP 2026" }]);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].channel).toBe("D-U1");
    expect(s.posts[0].blocks[0]).toMatchObject({ type: "context" });
    expect(s.posts[0].blocks.find((b) => (b as { type: string }).type === "image")).toMatchObject({ slack_file: { id: "F1" } });
    expect(s.posts[0].text.startsWith("[🧪 Test: R&amp;D's weekly digest, sent to you by Admin] AI spend · R&amp;D")).toBe(true);
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
    const banner = "🧪 Test: R&D's weekly digest, sent to you by Admin";
    await deliverTeamDigest({ ...args(slack.client, { sleep: async (ms: number) => { waits.push(ms); } }), digest: teamDigest, banner });
    expect(posts.map(hasImage)).toEqual([true, true, false]);
    expect(waits).toEqual([1500]);
    // the text-only fallback is still marked as a test: the banner leads every attempt
    const lead = { type: "context", elements: [{ type: "mrkdwn", text: "🧪 Test: R&amp;D's weekly digest, sent to you by Admin" }] };
    expect(posts.map((b) => b[0])).toEqual([lead, lead, lead]);
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

  it("keeps the banner on the text-only fallback after Slack rejects the image blocks", async () => {
    const posts: unknown[][] = [];
    const slack = fakeSlack({
      postMessage: async (_c, blocks) => {
        posts.push(blocks);
        if (hasImage(blocks)) throw new SlackApiError("chat.postMessage", "invalid_blocks");
        return "ts";
      },
    });
    await deliverDigest({ ...args(slack.client), digest: personDigest, banner: "🧪 Test message from Admin — not a scheduled digest" });
    expect(posts.map(hasImage)).toEqual([true, true, false]);
    expect(posts[2][0]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "🧪 Test message from Admin — not a scheduled digest" }] });
  });

  it("passes a banner through to the message", async () => {
    const s = fakeSlack();
    await deliverDigest({ ...args(s.client), digest: personDigest, banner: "🧪 Test message from Admin — not a scheduled digest" });
    expect(s.posts[0].blocks[0]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "🧪 Test message from Admin — not a scheduled digest" }] });
    expect(s.posts[0].text.startsWith("[🧪 Test message from Admin — not a scheduled digest] Your AI spend")).toBe(true);
  });
});

describe("resolveSlackUser", () => {
  const t0 = Date.parse("2026-10-07T09:30:00Z");
  const counting = (answer: () => Promise<{ id: string; tz: string | null } | null>) => {
    const calls: string[] = [];
    return { calls, slack: fakeSlack({ lookupUserByEmail: async (email) => { calls.push(email); return answer(); } }).client };
  };

  it("looks a person up once, then serves their id and zone from the cache", async () => {
    const store = memoryStore({}, () => t0);
    const { calls, slack } = counting(async () => ({ id: "U1", tz: "Europe/London" }));
    expect(await resolveSlackUser(store, slack, people[0], new Date(t0))).toEqual({ slackUserId: "U1", tz: "Europe/London" });
    expect(await resolveSlackUser(store, slack, people[0], new Date(t0 + 3_600_000))).toEqual({ slackUserId: "U1", tz: "Europe/London" });
    expect(calls).toEqual(["a@x.com"]);
  });

  it("refreshes after a week so a changed zone is picked up, keeping the cached answer if Slack errors", async () => {
    let t = t0;
    const store = memoryStore({}, () => t);
    let answer: () => Promise<{ id: string; tz: string | null } | null> = async () => ({ id: "U1", tz: "Europe/London" });
    const { calls, slack } = counting(() => answer());
    await resolveSlackUser(store, slack, people[0], new Date(t));
    t += SLACK_USER_TTL_MS + 1;
    answer = async () => ({ id: "U1", tz: "America/Sao_Paulo" });
    expect(await resolveSlackUser(store, slack, people[0], new Date(t))).toEqual({ slackUserId: "U1", tz: "America/Sao_Paulo" });
    t += SLACK_USER_TTL_MS + 1;
    answer = async () => { throw new SlackApiError("users.lookupByEmail", "ratelimited"); };
    expect(await resolveSlackUser(store, slack, people[0], new Date(t))).toEqual({ slackUserId: "U1", tz: "America/Sao_Paulo" });
    expect(calls).toHaveLength(3);
  });

  it("re-looks-up a cached user with no zone straight away (rows saved before zones were stored)", async () => {
    const store = memoryStore({}, () => t0);
    store.slackUserCache.set("a", { slackUserId: "U1", tz: null, lookedUpAt: new Date(t0).toISOString() });
    const { calls, slack } = counting(async () => ({ id: "U1", tz: "Europe/London" }));
    expect(await resolveSlackUser(store, slack, people[0], new Date(t0))).toEqual({ slackUserId: "U1", tz: "Europe/London" });
    expect(calls).toHaveLength(1);
  });

  it("caches a found user Slack gives no zone for as London, so they aren't looked up every hour", async () => {
    const store = memoryStore({}, () => t0);
    const { calls, slack } = counting(async () => ({ id: "U1", tz: null }));
    expect(await resolveSlackUser(store, slack, people[0], new Date(t0))).toEqual({ slackUserId: "U1", tz: "Europe/London" });
    expect(await resolveSlackUser(store, slack, people[0], new Date(t0 + 3_600_000))).toEqual({ slackUserId: "U1", tz: "Europe/London" });
    expect(calls).toHaveLength(1);
  });

  it("trusts a cached not-found for a week", async () => {
    const store = memoryStore({}, () => t0);
    const { calls, slack } = counting(async () => null);
    expect(await resolveSlackUser(store, slack, people[0], new Date(t0))).toBeNull();
    expect(await resolveSlackUser(store, slack, people[0], new Date(t0 + 86_400_000))).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
