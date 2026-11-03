import { describe, expect, it } from "vitest";
import type { RecommendationsData } from "@/lib/recommendations/load";
import { latestSunday } from "@/lib/recommendations/rule";
import { memoryStore, type MemorySeed } from "./memory-store";
import { runRecommendations, type RecommendationsRunDeps } from "./run-recommendations";
import type { SlackClient } from "./slack-client";
import type { NotifyEmployee } from "./types";

const MON = new Date("2026-11-09T10:45:00Z"); // Monday 10:45 London (GMT in November); latest week 2026-W45, 2–8 Nov
const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: `Person ${id}`, department: "Eng", oktaId: `00u${id}`, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
function fakeSlack(tz = "Europe/London") {
  const posts: { channel: string; blocks: unknown[]; text: string }[] = [];
  const client: SlackClient = {
    lookupUserByEmail: async (email) => ({ id: `U-${email.split("@")[0]}`, tz }),
    openDm: async (u) => `D-${u}`,
    uploadImage: async () => "F1",
    postMessage: async (channel, blocks, text) => { posts.push({ channel, blocks, text }); return `ts${posts.length}`; },
  };
  return { client, posts };
}
const data = (sunday: string, ready = true): RecommendationsData => ({
  sunday,
  weeks: [],
  tools: [{
    tool: "cursor", stepUpUsd: 80, premiumCount: 0, totalSavingUsd: 120,
    rows: [{ employeeId: "e1", name: "Tom Okafor", department: "Eng", tierUnknown: false, extraUsd: 200, savingUsd: 120, weeks: [], pattern: "steady", newThisWeek: false }],
  }],
  readiness: ready ? { ready: true, outstanding: [] } : { ready: false, outstanding: [{ kind: "claudeSpend", asOf: "2026-11-01" }, { kind: "sync", source: "cursor", lastSuccessDay: "2026-11-05" }] },
  rosterAsOf: { cursor: "2026-11-02" },
  cursorRosterStale: false,
  departments: ["Eng"],
  updatedAt: "2026-11-09T09:00:00Z",
});
/** A loader stub serving the week ending the Sunday before `now`, as loadRecommendations does; records its calls. */
function loader(ready = true) {
  const calls: Date[] = [];
  const loadData = async (now: Date) => {
    calls.push(now);
    return data(latestSunday(now), ready);
  };
  return { loadData, calls };
}
const seed = (over: MemorySeed = {}): MemorySeed => ({
  employees: [emp("g"), emp("m"), emp("left", { leaveDate: "2026-10-01" })],
  recommendationRecipients: ["g", "left"],
  dashboardAccess: ["g@x.com"],
  ...over,
});
const deps = (store: ReturnType<typeof memoryStore>, slack: SlackClient, loadData: RecommendationsRunDeps["loadData"], over: Partial<RecommendationsRunDeps> = {}): RecommendationsRunDeps => {
  const now = over.now ?? MON;
  return {
    store, slack, renderChart: async () => { throw new Error("no charts in this message"); }, mode: "live", previewEmail: null, now,
    baseUrl: "https://x.test", adminEmails: [], clock: () => now.getTime(), log: () => {}, sleep: async () => {}, loadData, ...over,
  };
};

describe("runRecommendations", () => {
  it("sends the latest week to each recipient on a working day from 10:30 local and claims it", async () => {
    const store = memoryStore(seed({ recommendationRecipients: ["g", "m", "left"] }), () => MON.getTime());
    const slack = fakeSlack();
    const { loadData, calls } = loader();
    expect(await runRecommendations(deps(store, slack.client, loadData))).toEqual({ periodKey: "2026-W45", sent: 2, failed: 0, alreadyHandled: 0, waiting: 0, held: null });
    expect(calls).toEqual([MON]); // loaded once for everyone
    expect(slack.posts.map((p) => p.channel)).toEqual(["D-U-g", "D-U-m"]); // a leaver gets nothing
    expect(slack.posts[0].text).toBe("Premium seat recommendations: 1 person, $120 potential saving a month");
    const g = store.sends.find((s) => s.employeeId === "g")!;
    expect(g).toMatchObject({ cadence: "weekly", periodKey: "2026-W45", mode: "live", report: "recommendations", status: "sent", slackTs: "ts1", dashboardLink: true });
    expect(slack.posts[0].blocks.at(-1)).toMatchObject({ type: "actions", elements: [{ url: `https://x.test/api/digest/open/${g.id}` }] });
    // No dashboard access: the message, without the button.
    expect(store.sends.find((s) => s.employeeId === "m")).toMatchObject({ report: "recommendations", status: "sent", dashboardLink: false });
    expect(JSON.stringify(slack.posts[1].blocks)).not.toContain("Open recommendations");
  });

  it("waits before 10:30 local", async () => {
    const early = new Date("2026-11-09T09:00:00Z");
    const store = memoryStore(seed(), () => early.getTime());
    const slack = fakeSlack();
    const { loadData, calls } = loader();
    expect(await runRecommendations(deps(store, slack.client, loadData, { now: early }))).toMatchObject({ periodKey: null, sent: 0, waiting: 1, held: null });
    expect(store.sends).toHaveLength(0);
    expect(slack.posts).toHaveLength(0);
    expect(calls).toHaveLength(0); // nothing loaded when nobody is due
  });

  it("an unready week is never claimed; the next Monday moves on", async () => {
    const fri = new Date("2026-11-13T10:45:00Z");
    const store = memoryStore(seed(), () => fri.getTime());
    const slack = fakeSlack();
    expect(await runRecommendations(deps(store, slack.client, loader(false).loadData, { now: fri }))).toMatchObject({
      periodKey: "2026-W45", sent: 0, failed: 0, held: "Claude Team (pasted as of 1 Nov) · Cursor sync",
    });
    expect(store.sends).toHaveLength(0);
    expect(slack.posts).toHaveLength(0);

    const nextMon = new Date("2026-11-16T10:45:00Z");
    expect(await runRecommendations(deps(store, slack.client, loader().loadData, { now: nextMon }))).toMatchObject({ periodKey: "2026-W46", sent: 1, held: null });
    expect(store.sends).toHaveLength(1);
    expect(store.sends[0]).toMatchObject({ employeeId: "g", periodKey: "2026-W46", report: "recommendations", status: "sent" });
  });

  it("never sends twice", async () => {
    const store = memoryStore(seed(), () => MON.getTime());
    const slack = fakeSlack();
    const { loadData, calls } = loader();
    expect(await runRecommendations(deps(store, slack.client, loadData))).toMatchObject({ sent: 1 });
    expect(await runRecommendations(deps(store, slack.client, loadData))).toMatchObject({ periodKey: "2026-W45", sent: 0, alreadyHandled: 1 });
    expect(slack.posts).toHaveLength(1);
    expect(store.sends).toHaveLength(1);
    expect(calls).toHaveLength(1); // the second run stops before loading
  });

  it("only: sends now for the given week and people, forced past readiness", async () => {
    const sat = new Date("2026-11-14T08:00:00Z"); // a Saturday morning: Send now doesn't wait
    const store = memoryStore(seed({ recommendationRecipients: ["g", "m"] }), () => sat.getTime());
    const slack = fakeSlack();
    const only = { periodKey: "2026-W45", employeeIds: ["m"] };
    expect(await runRecommendations(deps(store, slack.client, loader(false).loadData, { now: sat, only }))).toMatchObject({
      periodKey: "2026-W45", sent: 0, held: "Claude Team (pasted as of 1 Nov) · Cursor sync",
    });
    expect(store.sends).toHaveLength(0);

    expect(await runRecommendations(deps(store, slack.client, loader(false).loadData, { now: sat, only: { ...only, force: true } }))).toMatchObject({
      periodKey: "2026-W45", sent: 1, waiting: 0, held: null,
    });
    expect(slack.posts.map((p) => p.channel)).toEqual(["D-U-m"]);
    expect(store.sends).toEqual([expect.objectContaining({ employeeId: "m", cadence: "weekly", periodKey: "2026-W45", report: "recommendations", status: "sent" })]);
  });

  it("holds a week the loaded data isn't for, claiming nothing", async () => {
    const store = memoryStore(seed(), () => MON.getTime());
    const slack = fakeSlack();
    const older = { periodKey: "2026-W44", force: true }; // the loader serves only the latest week
    expect(await runRecommendations(deps(store, slack.client, loader().loadData, { only: older }))).toMatchObject({ periodKey: "2026-W44", sent: 0, held: "data window mismatch" });
    expect(store.sends).toHaveLength(0);
    expect(slack.posts).toHaveLength(0);
  });

  it("in preview mode goes to the previewer, marked as a preview", async () => {
    const store = memoryStore(seed({ employees: [emp("g"), emp("p")], recommendationRecipients: ["g"] }), () => MON.getTime());
    const slack = fakeSlack();
    expect(await runRecommendations(deps(store, slack.client, loader().loadData, { mode: "preview", previewEmail: "P@x.com " }))).toMatchObject({ sent: 1 });
    expect(slack.posts[0].channel).toBe("D-U-p");
    expect(slack.posts[0].text.startsWith("[Preview for Person g] ")).toBe(true);
    expect(store.sends[0]).toMatchObject({ employeeId: "g", mode: "preview", report: "recommendations", dashboardLink: true });
  });

  it("loader failure is contained", async () => {
    const store = memoryStore(seed(), () => MON.getTime());
    const slack = fakeSlack();
    const loadData = async () => { throw new Error("spend_facts: simulated outage"); };
    const r = await runRecommendations(deps(store, slack.client, loadData));
    expect(r).toMatchObject({ periodKey: "2026-W45", sent: 0, failed: 1 });
    expect(r.error).toMatch(/simulated outage/);
    expect(store.sends).toHaveLength(0);
    expect(slack.posts).toHaveLength(0);
  });
});
