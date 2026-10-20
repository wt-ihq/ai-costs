import { describe, expect, it } from "vitest";
import { memoryStore, type MemorySeed } from "./memory-store";
import type { RunNotifyDeps } from "./run-notify";
import { runReminders } from "./run-reminders";
import type { SlackClient } from "./slack-client";
import type { NotifyEmployee } from "./types";

const MON = new Date("2026-10-19T08:30:00Z"); // 09:30 BST Monday
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
const seed = (over: MemorySeed = {}): MemorySeed => ({
  employees: [emp("g"), emp("m")],
  reminderRecipients: ["g"],
  subscriptions: [{ employeeId: "m", cadence: "weekly" }],
  syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-10-19T06:00:03Z" }],
  manualImports: [{ source: "claude_team", kind: "clipboard", dataAsOf: "2026-10-11" }],
  ...over,
});
const deps = (store: ReturnType<typeof memoryStore>, slack: SlackClient, over: Partial<RunNotifyDeps> = {}): RunNotifyDeps => ({
  store, slack, renderChart: async () => new Uint8Array([1]) as Uint8Array<ArrayBuffer>, mode: "live", previewEmail: "g@x.com", now: MON,
  baseUrl: "https://x.test", adminEmails: [], clock: () => MON.getTime(), log: () => {}, sleep: async () => {}, ...over,
});

describe("runReminders", () => {
  it("DMs the Monday reminder once, listing what's outstanding and who's waiting", async () => {
    const store = memoryStore(seed(), () => MON.getTime());
    const slack = fakeSlack();
    expect(await runReminders(deps(store, slack.client))).toMatchObject({ due: ["weekly:2026-W42"], sent: 1 });
    expect(slack.posts[0].channel).toBe("D-U-g");
    expect(JSON.stringify(slack.posts[0].blocks)).toContain("Claude Team spend* — pasted as of 11 Oct");
    expect(JSON.stringify(slack.posts[0].blocks)).toContain("1 weekly summary goes out automatically");
    expect(store.sends[0]).toMatchObject({ employeeId: "g", cadence: "weekly", periodKey: "2026-W42", report: "reminder", status: "sent" });
    expect(await runReminders(deps(store, slack.client))).toMatchObject({ sent: 0, alreadyHandled: 1 });
    expect(slack.posts).toHaveLength(1);
  });

  it("waits until 09:30 local and sends nothing on a Tuesday", async () => {
    const early = new Date("2026-10-19T08:29:00Z");
    expect(await runReminders(deps(memoryStore(seed()), fakeSlack().client, { now: early, clock: () => early.getTime() }))).toMatchObject({ sent: 0, waiting: 1 });
    const tue = new Date("2026-10-20T08:30:00Z");
    expect(await runReminders(deps(memoryStore(seed()), fakeSlack().client, { now: tue, clock: () => tue.getTime() }))).toMatchObject({ sent: 0, due: [] });
  });

  it("sends the month-end Claude Team reminder on the last working day", async () => {
    const fri = new Date("2026-10-30T15:00:00Z");
    const slack = fakeSlack();
    expect(await runReminders(deps(memoryStore(seed()), slack.client, { now: fri, clock: () => fri.getTime() }))).toMatchObject({ due: ["monthEnd:2026-10"], sent: 1 });
    expect(slack.posts[0].text).toBe("Paste Claude Team spend today");
  });

  it("a reminder doesn't use up someone's first-message intro", async () => {
    const store = memoryStore(seed(), () => MON.getTime());
    await runReminders(deps(store, fakeSlack().client));
    expect(await store.everLive(["g"])).toEqual(new Set());
  });

  it("a reminder has no tracked open: its send id isn't one", async () => {
    const store = memoryStore(seed(), () => MON.getTime());
    await runReminders(deps(store, fakeSlack().client));
    expect(await store.markOpened(store.sends[0].id!)).toBeNull();
  });

  it("in preview mode goes to the previewer, marked as a preview", async () => {
    const store = memoryStore(seed({ employees: [emp("g"), emp("m"), emp("p")], reminderRecipients: ["g"] }), () => MON.getTime());
    const slack = fakeSlack();
    await runReminders(deps(store, slack.client, { mode: "preview", previewEmail: "p@x.com" }));
    expect(slack.posts[0].channel).toBe("D-U-p");
    expect(slack.posts[0].text.startsWith("[Preview for Person g] ")).toBe(true);
  });

  it("never throws: a broken reminder list can't stop the digests that run after it", async () => {
    const r = await runReminders(deps(memoryStore(seed({ reminderRecipientsFails: true })), fakeSlack().client));
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(r.error).toMatch(/simulated/);
  });

  it("does nothing without recipients", async () => {
    expect(await runReminders(deps(memoryStore(seed({ reminderRecipients: [] })), fakeSlack().client))).toMatchObject({ due: [], sent: 0 });
  });
});
