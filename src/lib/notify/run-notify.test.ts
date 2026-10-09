import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import { memoryStore, type MemorySeed } from "./memory-store";
import { runNotify, STALE_PENDING_MS, type RunNotifyDeps } from "./run-notify";
import { SlackApiError, type SlackClient } from "./slack-client";
import type { NotifyEmployee } from "./types";

const MONDAY = new Date("2026-09-28T09:30:00Z"); // 10:30 BST: daily for Friday 2026-09-25 + weekly 2026-W39 due
const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: `Person ${id}`, department: "Eng", oktaId: `00u${id}`, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
const fact = (day: string, usd: number, employeeId: string): ShapeFact => ({
  day, source: "cursor", costType: "overage", costUsd: usd, employeeId, department: "Eng", fullName: null, entityKey: employeeId, model: "",
});
const seed = (over: MemorySeed = {}): MemorySeed => ({
  employees: [emp("m"), emp("a", { managerRef: "00um" }), emp("gareth"), emp("gone", { leaveDate: "2026-09-01", employmentStatus: "deprovisioned" })],
  facts: [fact("2026-09-25", 12, "a"), fact("2026-09-22", 30, "m"), fact("2026-09-23", 50, "a")],
  subscriptions: [{ employeeId: "a", cadence: "daily" }, { employeeId: "m", cadence: "weekly" }, { employeeId: "gone", cadence: "weekly" }],
  syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-09-28T06:00:03Z" }],
  ...over,
});

function fakeSlack(over: Partial<SlackClient> = {}) {
  const posts: { channel: string; blocks: unknown[]; text: string }[] = [];
  const uploads: string[] = [];
  const client: SlackClient = {
    lookupUserByEmail: async (email) => (email.endsWith("@x.com") ? { id: `U-${email.split("@")[0]}`, tz: "Europe/London" } : null),
    openDm: async (u) => `D-${u}`,
    uploadImage: async (_png, name) => {
      uploads.push(name);
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
const deps = (store: ReturnType<typeof memoryStore>, slack: SlackClient, over: Partial<RunNotifyDeps> = {}): RunNotifyDeps => ({
  store, slack, renderChart: png, mode: "live", previewEmail: "gareth@x.com", now: MONDAY, baseUrl: "https://x.test",
  clock: () => MONDAY.getTime(), log: () => {}, sleep: async () => {}, ...over,
});
const hasImage = (blocks: unknown[]) => blocks.some((b) => (b as { type: string }).type === "image");

describe("runNotify", () => {
  it("sends each due digest once; a second run sends nothing", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    const slack = fakeSlack();
    const first = await runNotify(deps(store, slack.client));
    expect(first).toMatchObject({ due: ["daily:2026-09-25", "weekly:2026-W39"], sent: 2, failed: 0 });
    expect(slack.posts.map((p) => p.channel).sort()).toEqual(["D-U-a", "D-U-m"]);
    expect(store.sends.every((s) => s.status === "sent" && s.slackTs)).toBe(true);

    const second = await runNotify(deps(store, slack.client));
    expect(second).toMatchObject({ sent: 0, alreadyHandled: 2 });
    expect(slack.posts).toHaveLength(2);
  });

  it("each DM's dashboard button opens through its own send's tracked link", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    const slack = fakeSlack();
    await runNotify(deps(store, slack.client));
    for (const post of slack.posts) {
      const button = (post.blocks.at(-1) as { elements: { url: string }[] }).elements[0];
      const row = store.sends.find((s) => `D-U-${s.employeeId}` === post.channel)!;
      expect(button.url).toBe(`https://x.test/api/digest/open/${row.id}`);
    }
  });

  it("never sends to leavers", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    await runNotify(deps(store, fakeSlack().client));
    expect(store.sends.some((s) => s.employeeId === "gone")).toBe(false);
  });

  it("preview mode redirects every DM to the preview address and logs mode=preview", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    const slack = fakeSlack();
    await runNotify(deps(store, slack.client, { mode: "preview" }));
    expect(slack.posts.every((p) => p.channel === "D-U-gareth")).toBe(true);
    expect(JSON.stringify(slack.posts[0].blocks[0])).toContain("would send to");
    expect(store.sends.every((s) => s.mode === "preview")).toBe(true);
    const live = await runNotify(deps(store, slack.client));
    expect(live.sent).toBe(2); // previews never count as live sends
  });

  it("refuses to run preview without a matching SLACK_PREVIEW_EMAIL", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    await expect(runNotify(deps(store, fakeSlack().client, { mode: "preview", previewEmail: "nobody@elsewhere.com" }))).rejects.toThrow(/SLACK_PREVIEW_EMAIL/);
  });

  it("isolates failures per recipient", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    let n = 0;
    const slack = fakeSlack({ postMessage: async () => { if (n++ === 0) throw new SlackApiError("chat.postMessage", "channel_not_found"); return "ts"; } });
    const r = await runNotify(deps(store, slack.client));
    expect(r).toMatchObject({ sent: 1, failed: 1 });
    expect(store.sends.find((s) => s.status === "failed")!.detail).toBe("channel_not_found");
  });

  it("retries a failed send while attempts remain, then stops", async () => {
    const base = { cadence: "daily" as const, periodKey: "2026-09-25", mode: "live" as const, slackTs: null, detail: "x", updatedAt: "2026-09-28T06:59:00Z", employeeId: "a" };
    const retry = memoryStore(seed({ sends: [{ ...base, status: "failed", attempts: 1 }] }), () => MONDAY.getTime());
    expect((await runNotify(deps(retry, fakeSlack().client))).sent).toBe(2);
    const spent = memoryStore(seed({ sends: [{ ...base, status: "failed", attempts: 3 }] }), () => MONDAY.getTime());
    expect(await runNotify(deps(spent, fakeSlack().client))).toMatchObject({ sent: 1, alreadyHandled: 1 });
  });

  it("expires stale pending rows as interrupted and never resends them", async () => {
    const stale = new Date(MONDAY.getTime() - STALE_PENDING_MS - 1000).toISOString();
    const store = memoryStore(
      seed({ sends: [{ employeeId: "a", cadence: "daily", periodKey: "2026-09-25", mode: "live", status: "pending", attempts: 1, slackTs: null, detail: null, updatedAt: stale }] }),
      () => MONDAY.getTime(),
    );
    const slack = fakeSlack();
    const r = await runNotify(deps(store, slack.client));
    expect(r).toMatchObject({ expired: 1, alreadyHandled: 1, sent: 1 });
    expect(store.sends.find((s) => s.employeeId === "a")).toMatchObject({ status: "failed", detail: "interrupted" });
    expect(slack.posts.map((p) => p.channel)).toEqual(["D-U-m"]);
  });

  it("does not resend when the DB write fails AFTER a successful post", async () => {
    const store = memoryStore(seed({ subscriptions: [{ employeeId: "a", cadence: "daily" }] }), () => MONDAY.getTime());
    store.failNextFinish = true;
    const slack = fakeSlack();
    const r = await runNotify(deps(store, slack.client));
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(store.sends[0].status).toBe("pending"); // left pending → expires as interrupted, never retried
    await runNotify(deps(store, slack.client));
    expect(slack.posts).toHaveLength(1);
  });

  it("stops claiming new recipients past the time budget", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    let t = MONDAY.getTime();
    const slack = fakeSlack({ postMessage: async () => { t += 300_000; return "ts"; } });
    const r = await runNotify(deps(store, slack.client, { clock: () => t, budgetMs: 240_000 }));
    expect(r).toMatchObject({ sent: 1, notReached: 1 });
  });

  it("sends text-only when chart rendering fails", async () => {
    const store = memoryStore(seed(), () => MONDAY.getTime());
    const slack = fakeSlack();
    const r = await runNotify(deps(store, slack.client, { renderChart: async () => { throw new Error("satori"); } }));
    expect(r.sent).toBe(2);
    expect(slack.posts.some((p) => hasImage(p.blocks))).toBe(false);
  });

  it("resends without images when Slack rejects the image blocks", async () => {
    const store = memoryStore(seed({ subscriptions: [{ employeeId: "a", cadence: "daily" }] }), () => MONDAY.getTime());
    const posts: unknown[][] = [];
    const slack = fakeSlack({
      postMessage: async (_c, blocks) => {
        posts.push(blocks);
        if (hasImage(blocks)) throw new SlackApiError("chat.postMessage", "invalid_blocks");
        return "ts";
      },
    });
    expect((await runNotify(deps(store, slack.client))).sent).toBe(1);
    // the image post is attempted twice (a racing image block gets one retry) before the text-only fallback
    expect(posts.map(hasImage)).toEqual([true, true, false]);
  });

  it("retries the same image blocks once after a pause when the first attempt raced the upload", async () => {
    const store = memoryStore(seed({ subscriptions: [{ employeeId: "a", cadence: "daily" }] }), () => MONDAY.getTime());
    const posts: unknown[][] = [];
    const slack = fakeSlack({
      postMessage: async (_c, blocks) => {
        posts.push(blocks);
        if (posts.length === 1) throw new SlackApiError("chat.postMessage", "invalid_blocks");
        return "ts";
      },
    });
    const waits: number[] = [];
    const r = await runNotify(deps(store, slack.client, { sleep: async (ms) => { waits.push(ms); } }));
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(posts.map(hasImage)).toEqual([true, true]);
    expect(posts[1]).toEqual(posts[0]);
    expect(waits).toEqual([1500]);
  });

  it("does not pause or retry an image post that is rejected for any other reason", async () => {
    const store = memoryStore(seed({ subscriptions: [{ employeeId: "a", cadence: "daily" }] }), () => MONDAY.getTime());
    let posts = 0;
    const slack = fakeSlack({ postMessage: async () => { posts++; throw new SlackApiError("chat.postMessage", "http_429"); } });
    const waits: number[] = [];
    const r = await runNotify(deps(store, slack.client, { sleep: async (ms) => { waits.push(ms); } }));
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(posts).toBe(1);
    expect(waits).toEqual([]);
    expect(store.sends[0]).toMatchObject({ status: "failed", detail: "http_429" }); // Slack said no: retryable next run
  });

  it.each([
    ["a network error", () => new TypeError("fetch failed")],
    ["an HTTP 5xx", () => new SlackApiError("chat.postMessage", "http_502")],
    ["a Slack internal_error", () => new SlackApiError("chat.postMessage", "internal_error")],
  ])("an ambiguous post failure (%s) leaves the row pending and is never resent", async (_label, boom) => {
    const store = memoryStore(seed({ subscriptions: [{ employeeId: "a", cadence: "daily" }] }), () => MONDAY.getTime());
    const logs: string[] = [];
    const broken = fakeSlack({ postMessage: async () => { throw boom(); } });
    const r = await runNotify(deps(store, broken.client, { log: (m) => logs.push(m) }));
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(store.sends[0].status).toBe("pending"); // Slack may have accepted it: never retryable
    expect(logs.some((m) => m.includes("post outcome unknown employee=a cadence=daily"))).toBe(true);

    const working = fakeSlack();
    const again = await runNotify(deps(store, working.client));
    expect(again).toMatchObject({ sent: 0, alreadyHandled: 1 });
    expect(working.posts).toHaveLength(0);

    // even once the stale sweep has marked it interrupted, it is still never resent
    const later = new Date(MONDAY.getTime() + STALE_PENDING_MS + 1000);
    const sweep = await runNotify(deps(store, working.client, { clock: () => later.getTime() }));
    expect(sweep).toMatchObject({ expired: 1, sent: 0, alreadyHandled: 1 });
    expect(store.sends[0]).toMatchObject({ status: "failed", detail: "interrupted" });
    expect(working.posts).toHaveLength(0);
  });

  it("a claim error is isolated to that recipient", async () => {
    const inner = memoryStore(seed(), () => MONDAY.getTime());
    const finished: string[] = [];
    const store = {
      ...inner,
      claimSend: async (k: Parameters<typeof inner.claimSend>[0]) => {
        if (k.employeeId === "a") throw new Error("db down");
        return inner.claimSend(k);
      },
      finishSend: async (k: Parameters<typeof inner.finishSend>[0], r: Parameters<typeof inner.finishSend>[1]) => {
        finished.push(k.employeeId);
        return inner.finishSend(k, r);
      },
    };
    const logs: string[] = [];
    const slack = fakeSlack();
    const r = await runNotify(deps(store, slack.client, { log: (m) => logs.push(m) }));
    expect(r).toMatchObject({ sent: 1, failed: 1 }); // m's weekly still goes out
    expect(slack.posts.map((p) => p.channel)).toEqual(["D-U-m"]);
    expect(finished).toEqual(["m"]); // never touches a row this run doesn't own
    expect(inner.sends.some((s) => s.employeeId === "a")).toBe(false);
    expect(logs).toContain("[notify] claim failed employee=a cadence=daily: db down");
  });

  it("skips daily/weekly entirely when no source synced today", async () => {
    const store = memoryStore(seed({ syncRuns: [] }), () => MONDAY.getTime());
    const slack = fakeSlack();
    const r = await runNotify(deps(store, slack.client));
    expect(r.due).toEqual([]);
    expect(r.note).toMatch(/no source has synced since 2026-09-28/);
    expect(slack.posts).toHaveLength(0);
  });

  it("logs a daily with no usage as skipped and a missing Slack account as failed", async () => {
    const store = memoryStore(
      seed({ facts: [fact("2026-09-22", 30, "m")], employees: [emp("m"), emp("a", { managerRef: "00um" }), emp("gareth")] }),
      () => MONDAY.getTime(),
    );
    const r = await runNotify(deps(store, fakeSlack().client));
    expect(store.sends.find((s) => s.employeeId === "a")).toMatchObject({ status: "skipped", detail: "no usage" });
    expect(r.skipped).toBe(1);

    const noSlack = memoryStore(seed({ employees: [emp("m", { email: "m@elsewhere.com" }), emp("a", { managerRef: "00um" }), emp("gareth")] }), () => MONDAY.getTime());
    await runNotify(deps(noSlack, fakeSlack().client));
    expect(noSlack.sends.find((s) => s.employeeId === "m")).toMatchObject({ status: "failed", detail: "no Slack account" });
    expect(noSlack.slackUserCache.get("m")).toMatchObject({ slackUserId: null });
  });

  describe("10:30 local, working days only", () => {
    const at = (iso: string) => ({ now: new Date(iso), clock: () => Date.parse(iso) });

    it("waits until 10:30 in the recipient's zone, then sends — without loading spend data before", async () => {
      const store = memoryStore(seed(), () => MONDAY.getTime());
      const slack = fakeSlack();
      const early = await runNotify(deps(store, slack.client, at("2026-09-28T09:29:00Z"))); // 10:29 BST
      expect(early).toMatchObject({ sent: 0, waiting: 2 });
      expect(store.factCalls).toHaveLength(0);
      expect(store.sends).toHaveLength(0);
      expect(await runNotify(deps(store, slack.client, at("2026-09-28T09:30:00Z")))).toMatchObject({ sent: 2, waiting: 0 });
    });

    it("sends to someone in another zone at their own 10:30", async () => {
      const store = memoryStore(seed(), () => MONDAY.getTime());
      const slack = fakeSlack({
        lookupUserByEmail: async (email) => ({ id: `U-${email.split("@")[0]}`, tz: email.startsWith("m@") ? "America/Sao_Paulo" : "Europe/London" }),
      });
      expect(await runNotify(deps(store, slack.client, at("2026-09-28T09:30:00Z")))).toMatchObject({ sent: 1, waiting: 1 });
      expect(await runNotify(deps(store, slack.client, at("2026-09-28T13:30:00Z")))).toMatchObject({ sent: 1, alreadyHandled: 1 }); // 10:30 in São Paulo
      expect(slack.posts.map((p) => p.channel)).toEqual(["D-U-a", "D-U-m"]);
    });

    it("sends nothing at the weekend", async () => {
      const store = memoryStore(seed({ syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-10-03T06:00:03Z" }] }), () => MONDAY.getTime());
      const slack = fakeSlack();
      expect(await runNotify(deps(store, slack.client, at("2026-10-03T12:00:00Z")))).toMatchObject({ sent: 0, waiting: 2 });
      expect(slack.posts).toHaveLength(0);
      expect(store.factCalls).toHaveLength(0);
    });

    it("skips the spend-data load once everyone due has been handled", async () => {
      const store = memoryStore(seed(), () => MONDAY.getTime());
      const slack = fakeSlack();
      await runNotify(deps(store, slack.client));
      const loads = store.factCalls.length;
      expect(await runNotify(deps(store, slack.client, at("2026-09-28T10:30:00Z")))).toMatchObject({ sent: 0, alreadyHandled: 2 });
      expect(store.factCalls).toHaveLength(loads);
    });

    it("a ?date= replay sends straight away, without the 10:30 wait", async () => {
      const store = memoryStore(seed(), () => MONDAY.getTime());
      const r = await runNotify(deps(store, fakeSlack().client, { mode: "preview", replay: true, ...at("2026-09-28T07:00:00Z") }));
      expect(r).toMatchObject({ sent: 2, waiting: 0 });
    });

    const zoned = (tz: string) => fakeSlack({ lookupUserByEmail: async (email) => ({ id: `U-${email.split("@")[0]}`, tz }) });

    it("holds someone whose 10:30 comes before that day's sync (UTC+11) until the first run after it", async () => {
      const runs = [{ source: "cursor", status: "success", startedAt: "2026-10-06T06:00:03Z" }];
      const store = memoryStore(seed({ subscriptions: [{ employeeId: "a", cadence: "daily" }], facts: [fact("2026-10-06", 12, "a")], syncRuns: runs }), () => MONDAY.getTime());
      const slack = zoned("Australia/Sydney");
      const early = await runNotify(deps(store, slack.client, at("2026-10-06T23:30:00Z"))); // Wed 10:30 AEDT — Tue isn't over in UTC
      expect(early).toMatchObject({ sent: 0, due: [] });
      expect(store.sends).toHaveLength(0);
      runs.push({ source: "cursor", status: "success", startedAt: "2026-10-07T06:00:03Z" });
      expect(await runNotify(deps(store, slack.client, at("2026-10-07T06:30:00Z")))).toMatchObject({ sent: 1, due: ["daily:2026-10-06"] });
    });

    it("a late western catch-up just after UTC midnight still counts its own day's sync", async () => {
      const store = memoryStore(
        seed({ subscriptions: [{ employeeId: "a", cadence: "daily" }], facts: [fact("2026-10-06", 12, "a")], syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-10-07T06:00:03Z" }] }),
        () => MONDAY.getTime(),
      );
      const r = await runNotify(deps(store, zoned("America/Sao_Paulo").client, at("2026-10-08T02:30:00Z"))); // 23:30 Wed local
      expect(r).toMatchObject({ sent: 1, due: ["daily:2026-10-06"] });
    });

    it("reads import coverage only on days a monthly could be due", async () => {
      const store = memoryStore(seed(), () => MONDAY.getTime());
      await runNotify(deps(store, fakeSlack().client));
      expect(store.coverageCalls).toHaveLength(0);
      const oct = memoryStore(seed({ syncRuns: [{ source: "cursor", status: "success", startedAt: "2026-10-05T06:00:03Z" }] }), () => MONDAY.getTime());
      await runNotify(deps(oct, fakeSlack().client, at("2026-10-05T09:30:00Z")));
      expect(oct.coverageCalls).toHaveLength(1);
    });

    it("stops resolving Slack users past the time budget, leaving the rest for the next run", async () => {
      const store = memoryStore(seed(), () => MONDAY.getTime());
      let t = MONDAY.getTime();
      const lookups: string[] = [];
      const slack = fakeSlack({ lookupUserByEmail: async (email) => { lookups.push(email); t += 300_000; return { id: `U-${email.split("@")[0]}`, tz: "Europe/London" }; } });
      const r = await runNotify(deps(store, slack.client, { clock: () => t, budgetMs: 240_000 }));
      expect(r).toMatchObject({ sent: 0, notReached: 2 });
      expect(lookups).toHaveLength(1);
      expect(store.sends).toHaveLength(0);
    });

    it("records a missing Slack account once, without loading spend data, and doesn't retry it that day", async () => {
      const store = memoryStore(seed({ employees: [emp("m", { email: "m@elsewhere.com" }), emp("gareth")], subscriptions: [{ employeeId: "m", cadence: "weekly" }] }), () => MONDAY.getTime());
      expect(await runNotify(deps(store, fakeSlack().client))).toMatchObject({ failed: 1, sent: 0 });
      expect(store.sends[0]).toMatchObject({ status: "failed", detail: "no Slack account" });
      expect(await runNotify(deps(store, fakeSlack().client, at("2026-09-28T10:30:00Z")))).toMatchObject({ failed: 0, alreadyHandled: 1 });
      expect(store.factCalls).toHaveLength(0);
    });

    it("a Slack lookup error leaves that person for the next run, untouched", async () => {
      const store = memoryStore(seed(), () => MONDAY.getTime());
      const logs: string[] = [];
      const slack = fakeSlack({
        lookupUserByEmail: async (email) => {
          if (email.startsWith("a@")) throw new SlackApiError("users.lookupByEmail", "ratelimited");
          return { id: `U-${email.split("@")[0]}`, tz: "Europe/London" };
        },
      });
      expect(await runNotify(deps(store, slack.client, { log: (m) => logs.push(m) }))).toMatchObject({ sent: 1, failed: 1 });
      expect(store.sends.some((s) => s.employeeId === "a")).toBe(false); // nothing claimed: the next run tries again
      expect(logs).toContain("[notify] Slack lookup failed employee=a: ratelimited");
    });
  });
});
