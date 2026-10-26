import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import { memoryStore, type MemorySeed } from "./memory-store";
import { catchUp, sendNow, type SendNowDeps } from "./send-now";
import type { SlackClient } from "./slack-client";
import type { NotifyEmployee } from "./types";

const SAT = new Date("2026-10-03T14:00:00Z");
const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: `Person ${id}`, department: "Eng", oktaId: `00u${id}`, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
const fact = (day: string, usd: number, employeeId: string): ShapeFact => ({
  day, source: "cursor", costType: "overage", costUsd: usd, employeeId, department: "Eng", fullName: null, entityKey: employeeId, model: "",
});
const synced = [{ source: "cursor", status: "success", startedAt: "2026-10-03T06:00:03Z" }];
const stale = [{ source: "cursor", status: "success", startedAt: "2026-09-25T06:00:03Z" }];
const seed = (over: MemorySeed = {}): MemorySeed => ({
  employees: [emp("m"), emp("a"), emp("gareth")],
  facts: [fact("2026-09-22", 30, "m"), fact("2026-09-23", 50, "a")],
  subscriptions: [{ employeeId: "m", cadence: "weekly" }],
  syncRuns: synced,
  ...over,
});
function fakeSlack(over: Partial<SlackClient> = {}) {
  const posts: { channel: string }[] = [];
  const client: SlackClient = {
    lookupUserByEmail: async (email) => (email.endsWith("@x.com") ? { id: `U-${email.split("@")[0]}`, tz: "Europe/London" } : null),
    openDm: async (u) => `D-${u}`,
    uploadImage: async () => "F1",
    postMessage: async (channel) => { posts.push({ channel }); return `ts${posts.length}`; },
    ...over,
  };
  return { client, posts };
}
const png = async () => new Uint8Array([1]) as Uint8Array<ArrayBuffer>;
const deps = (store: ReturnType<typeof memoryStore>, slack: SlackClient, over: Partial<SendNowDeps> = {}): SendNowDeps => ({
  store, slack, renderChart: png, mode: "live", previewEmail: "gareth@x.com", now: SAT, baseUrl: "https://x.test", adminEmails: [],
  clock: () => SAT.getTime(), log: () => {}, sleep: async () => {}, ...over,
});

describe("sendNow", () => {
  it("refuses when the mode is off", async () => {
    const r = await sendNow(deps(memoryStore(seed()), fakeSlack().client, { mode: "off" }), { cadence: "weekly", periodKey: "2026-W39" });
    expect(r).toEqual({ ok: false, error: "Choose Preview or Live first" });
  });

  it("refuses the daily", async () => {
    const r = await sendNow(deps(memoryStore(seed()), fakeSlack().client), { cadence: "daily", periodKey: "2026-10-02" });
    expect(r).toEqual({ ok: false, error: "Only weekly and monthly digests can be sent now" });
  });

  it("reports a preview inbox that matches nobody as an error, not a crash", async () => {
    const r = await sendNow(deps(memoryStore(seed()), fakeSlack().client, { mode: "preview", previewEmail: "nobody@x.com" }), { cadence: "weekly", periodKey: "2026-W39" });
    expect(r).toEqual({ ok: false, error: "SLACK_PREVIEW_EMAIL does not match an employee" });
  });

  it("sends a ready weekly", async () => {
    const slack = fakeSlack();
    const r = await sendNow(deps(memoryStore(seed(), () => SAT.getTime()), slack.client), { cadence: "weekly", periodKey: "2026-W39" });
    expect(r).toEqual({ ok: true, sent: 1, alreadyHandled: 0, failed: [], notReached: [], held: null });
    expect(slack.posts).toEqual([{ channel: "D-U-m" }]);
  });

  it("holds a monthly that isn't ready even when asked to force, saying what's missing", async () => {
    const store = memoryStore(seed({ syncRuns: stale, subscriptions: [{ employeeId: "m", cadence: "monthly" }] }), () => SAT.getTime());
    const r = await sendNow(deps(store, fakeSlack().client), { cadence: "monthly", periodKey: "2026-09", force: true });
    expect(r).toEqual({ ok: true, sent: 0, alreadyHandled: 0, failed: [], notReached: [], held: "Waiting for Cursor sync" });
  });

  it("names a person who has no Slack account", async () => {
    const slack = fakeSlack({ lookupUserByEmail: async () => null });
    const r = await sendNow(deps(memoryStore(seed(), () => SAT.getTime()), slack.client), { cadence: "weekly", periodKey: "2026-W39" });
    expect(r).toMatchObject({ ok: true, sent: 0, failed: [{ name: "Person m", detail: "no Slack account" }] });
  });
});

describe("catchUp (people just added to the Pilot list)", () => {
  it("sends the latest week to those with weekly; a held monthly is reported, not an error; people already sent are skipped", async () => {
    const MON = new Date("2026-10-05T12:00:00Z"); // latest complete week W40, latest complete month September
    const store = memoryStore(
      seed({
        facts: [fact("2026-10-01", 30, "m"), fact("2026-10-02", 50, "a")],
        syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-10-05T06:00:03Z" }],
        subscriptions: [{ employeeId: "m", cadence: "weekly" }, { employeeId: "a", cadence: "weekly" }, { employeeId: "a", cadence: "monthly" }],
        coverage: [{ month: "2026-08", chatgptSeats: null, chatgptCredits: { totalUsd: 1, lastImport: "2026-08-31" }, claudeSpend: null, claudeSeats: null }],
        sends: [{ employeeId: "m", cadence: "weekly", periodKey: "2026-W40", mode: "live", status: "sent", attempts: 1, slackTs: "t", detail: null, updatedAt: MON.toISOString() }],
      }),
      () => MON.getTime(),
    );
    const slack = fakeSlack();
    const r = await catchUp(deps(store, slack.client, { now: MON, clock: () => MON.getTime() }), ["m", "a"]);
    expect(r).toMatchObject({ ok: true, sent: 1, alreadyHandled: 1, failed: [] });
    expect(r.ok && r.held).toBe("Waiting for ChatGPT Business credits");
    expect(slack.posts).toEqual([{ channel: "D-U-a" }]);
  });
});
