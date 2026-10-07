import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import { memoryStore } from "./memory-store";
import { SlackApiError, type SlackClient } from "./slack-client";
import { sendTest, testBanner, type TestSendDeps } from "./test-send";
import type { NotifyEmployee } from "./types";

const NOW = new Date("2026-09-30T07:00:00Z");
const ID = {
  admin: "00000000-0000-4000-8000-0000000000a0",
  mgr: "00000000-0000-4000-8000-0000000000a1",
  rep: "00000000-0000-4000-8000-0000000000a2",
  ds: "00000000-0000-4000-8000-0000000000a3",
  gone: "00000000-0000-4000-8000-0000000000a4",
  nobody: "00000000-0000-4000-8000-0000000000ff",
};
const emp = (id: string, name: string, email: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email, fullName: name, department: "Eng", oktaId: null, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
const fact = (day: string, usd: number, employeeId: string, department = "Eng"): ShapeFact => ({
  day, source: "cursor", costType: "overage", costUsd: usd, employeeId, department, fullName: null, entityKey: employeeId, model: "",
});
const employees = [
  emp(ID.admin, "Gareth Admin", "gareth@x.com"),
  emp(ID.mgr, "Priya Nair", "priya@x.com", { oktaId: "00um" }),
  emp(ID.rep, "Alex Kim", "alex@x.com", { managerRef: "00um" }),
  emp(ID.ds, "Sam Lee", "sam@x.com", { department: "Data Science" }),
  emp(ID.gone, "Former Person", "former@x.com", { employmentStatus: "deprovisioned", leaveDate: "2026-09-01" }),
];
const facts = [fact("2026-09-22", 30, ID.mgr), fact("2026-09-23", 50, ID.rep), fact("2026-09-24", 96.5, ID.ds, "Data Science")];

function setup(over: { employees?: NotifyEmployee[]; slack?: Partial<SlackClient> } = {}) {
  const inner = memoryStore({ employees: over.employees ?? employees, facts }, () => NOW.getTime());
  const calls: string[] = [];
  // Any write to the send log is a bug: a test must neither block nor duplicate the scheduled send.
  const store = {
    ...inner,
    claimSend: async () => { calls.push("claimSend"); return true; },
    finishSend: async () => { calls.push("finishSend"); },
  };
  const posts: { channel: string; blocks: unknown[]; text: string }[] = [];
  const slack: SlackClient = {
    lookupUserByEmail: async (email) => (email.endsWith("@x.com") ? { id: `U-${email.split("@")[0]}`, tz: "Europe/London" } : null),
    openDm: async (u) => `D-${u}`,
    uploadImage: async () => "F1",
    postMessage: async (channel, blocks, text) => {
      posts.push({ channel, blocks, text });
      return "ts";
    },
    ...over.slack,
  };
  const logs: string[] = [];
  const deps: TestSendDeps = {
    store, slack, renderChart: async () => new Uint8Array([1]) as Uint8Array<ArrayBuffer>, now: NOW, baseUrl: "https://x.test",
    actorEmail: "gareth@x.com", log: (m) => logs.push(m), sleep: async () => {},
  };
  return { deps, posts, calls, logs, inner };
}
const first = (blocks: unknown[]) => JSON.stringify(blocks[0]);
const person = (employeeId: string) => ({ kind: "person" as const, employeeId });
const team = (department: string) => ({ kind: "team" as const, department });

describe("testBanner", () => {
  it("is plain about being a test; names the subject when it goes to someone else", () => {
    expect(testBanner({ adminName: "Gareth", subjectName: "Priya", cadence: "weekly", toSubject: true })).toBe("🧪 Test message from Gareth — not a scheduled digest");
    expect(testBanner({ adminName: "Gareth", subjectName: "Priya", cadence: "weekly", toSubject: false })).toBe("🧪 Test: Priya's weekly digest, sent to you by Gareth");
    expect(testBanner({ adminName: "Gareth", subjectName: "Eng", cadence: "monthly", toSubject: false })).toBe("🧪 Test: Eng's monthly digest, sent to you by Gareth");
  });
});

describe("sendTest — a person's digest", () => {
  it("to the person themself: their digest, DM'd to them, marked as a test from the admin", async () => {
    const t = setup();
    const r = await sendTest(t.deps, { subject: person(ID.mgr), cadence: "weekly", periodKey: "2026-W39", to: { kind: "subject" } });
    expect(r).toEqual({ ok: true, sentTo: "Priya Nair" });
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0].channel).toBe("D-U-priya");
    expect(first(t.posts[0].blocks)).toContain("🧪 Test message from Gareth Admin — not a scheduled digest");
    expect(t.posts[0].text).toContain("[🧪 Test message from Gareth Admin — not a scheduled digest] Your AI spend");
    expect(JSON.stringify(t.posts[0].blocks)).toContain("$30.00"); // Priya's own figure
  });

  it("to the admin (me): the subject's digest with the 'sent to you' banner", async () => {
    const t = setup();
    const r = await sendTest(t.deps, { subject: person(ID.mgr), cadence: "weekly", periodKey: "2026-W39", to: { kind: "me" } });
    expect(r).toEqual({ ok: true, sentTo: "Gareth Admin" });
    expect(t.posts[0].channel).toBe("D-U-gareth");
    expect(first(t.posts[0].blocks)).toContain("🧪 Test: Priya Nair's weekly digest, sent to you by Gareth Admin");
  });

  it("to any other chosen employee, with the same banner", async () => {
    const t = setup();
    const r = await sendTest(t.deps, { subject: person(ID.mgr), cadence: "weekly", periodKey: "2026-W39", to: { kind: "employee", employeeId: ID.ds } });
    expect(r).toEqual({ ok: true, sentTo: "Sam Lee" });
    expect(t.posts[0].channel).toBe("D-U-sam");
    expect(first(t.posts[0].blocks)).toContain("🧪 Test: Priya Nair's weekly digest, sent to you by Gareth Admin");
  });

  it("choosing the subject by id counts as sending to themself", async () => {
    const t = setup();
    await sendTest(t.deps, { subject: person(ID.rep), cadence: "weekly", periodKey: "2026-W39", to: { kind: "employee", employeeId: ID.rep } });
    expect(first(t.posts[0].blocks)).toContain("not a scheduled digest");
  });

  it("the admin testing their own digest gets the self banner", async () => {
    const t = setup();
    await sendTest(t.deps, { subject: person(ID.admin), cadence: "monthly", periodKey: "2026-08", to: { kind: "me" } });
    expect(first(t.posts[0].blocks)).toContain("🧪 Test message from Gareth Admin — not a scheduled digest");
  });

  it("falls back to the admin's email when they are not in the employee list", async () => {
    const t = setup({ employees: employees.filter((e) => e.id !== ID.admin) });
    const r = await sendTest(t.deps, { subject: person(ID.mgr), cadence: "weekly", periodKey: "2026-W39", to: { kind: "employee", employeeId: ID.rep } });
    expect(r.ok).toBe(true);
    expect(first(t.posts[0].blocks)).toContain("sent to you by gareth@x.com");
    const me = await sendTest(t.deps, { subject: person(ID.mgr), cadence: "weekly", periodKey: "2026-W39", to: { kind: "me" } });
    expect(me).toEqual({ ok: false, error: "Your email isn't in the employee list" });
  });

  it("can preview and test-send a leaver's digest to an active person", async () => {
    const t = setup();
    const r = await sendTest(t.deps, { subject: person(ID.gone), cadence: "monthly", periodKey: "2026-08", to: { kind: "me" } });
    expect(r.ok).toBe(true);
  });
});

describe("sendTest — a team's digest", () => {
  it("sends the department's digest to the chosen employee, marked with the department", async () => {
    const t = setup();
    const r = await sendTest(t.deps, { subject: team("Eng"), cadence: "weekly", periodKey: "2026-W39", to: { kind: "employee", employeeId: ID.ds } });
    expect(r).toEqual({ ok: true, sentTo: "Sam Lee" });
    const blocks = t.posts[0].blocks;
    expect(first(blocks)).toContain("🧪 Test: Eng's weekly digest, sent to you by Gareth Admin");
    expect(JSON.stringify(blocks)).toContain("AI spend · Eng · 21–27 Sep 2026");
    expect(JSON.stringify(blocks)).toContain("$80.00"); // 30 + 50: not Data Science's 96.50
    expect(JSON.stringify(blocks)).not.toContain("96.50");
    expect(JSON.stringify(blocks)).toContain("https://x.test/explore/Eng");
  });

  it("to me", async () => {
    const t = setup();
    const r = await sendTest(t.deps, { subject: team("Data Science"), cadence: "weekly", periodKey: "2026-W39", to: { kind: "me" } });
    expect(r).toEqual({ ok: true, sentTo: "Gareth Admin" });
    expect(t.posts[0].channel).toBe("D-U-gareth");
    expect(JSON.stringify(t.posts[0].blocks)).toContain("https://x.test/explore/Data%20Science");
  });

  it("'this person' makes no sense for a team", async () => {
    const t = setup();
    const r = await sendTest(t.deps, { subject: team("Eng"), cadence: "weekly", periodKey: "2026-W39", to: { kind: "subject" } });
    expect(r).toMatchObject({ ok: false });
    expect(t.posts).toHaveLength(0);
  });

  it("rejects a department that is not a real (active) team", async () => {
    const t = setup();
    for (const department of ["Nope", "", "eng", "Eng ", "Gone"]) {
      expect(await sendTest(t.deps, { subject: team(department), cadence: "weekly", periodKey: "2026-W39", to: { kind: "me" } })).toMatchObject({ ok: false });
    }
    expect(t.posts).toHaveLength(0);
  });
});

describe("sendTest — safety", () => {
  const ok = { subject: person(ID.mgr), cadence: "weekly", periodKey: "2026-W39", to: { kind: "me" } };

  it("never writes the send log, so it can neither block nor duplicate the scheduled send", async () => {
    const t = setup();
    await sendTest(t.deps, ok);
    await sendTest(t.deps, { ...ok, subject: team("Eng"), to: { kind: "employee", employeeId: ID.rep } });
    expect(t.calls).toEqual([]);
    expect(t.inner.sends).toEqual([]);
  });

  it("logs ids only: no names, no amounts", async () => {
    const t = setup();
    await sendTest(t.deps, { ...ok, to: { kind: "employee", employeeId: ID.rep } });
    await sendTest(t.deps, { ...ok, subject: team("Data Science") });
    expect(t.logs.filter((l) => l.startsWith("[notify] test send"))).toEqual([
      `[notify] test send subject=person:${ID.mgr} target=${ID.rep} cadence=weekly`,
      `[notify] test send subject=team:Data Science target=${ID.admin} cadence=weekly`,
    ]);
    const all = t.logs.join("\n");
    for (const secret of ["Priya", "Alex", "Gareth", "Sam", "$", "@x.com"]) expect(all).not.toContain(secret);
  });

  it.each([
    ["a malformed subject id", { ...ok, subject: person("1; drop table") }],
    ["a missing subject", { ...ok, subject: undefined }],
    ["an unknown subject kind", { ...ok, subject: { kind: "company" } }],
    ["a non-string department", { ...ok, subject: { kind: "team", department: 7 } }],
    ["an unknown cadence", { ...ok, cadence: "hourly" }],
    ["a non-string period", { ...ok, periodKey: 3 }],
    ["a period that is not of that cadence", { ...ok, periodKey: "2026-09" }],
    ["an unknown target kind", { ...ok, to: { kind: "everyone" } }],
    ["a missing target", { ...ok, to: undefined }],
    ["a malformed target employee id", { ...ok, to: { kind: "employee", employeeId: "x" } }],
  ])("rejects %s without touching Slack", async (_label, input) => {
    const t = setup();
    const r = await sendTest(t.deps, input);
    expect(r).toMatchObject({ ok: false });
    expect(t.posts).toHaveLength(0);
    expect(t.calls).toEqual([]);
  });

  it("only sends to ACTIVE employees that exist", async () => {
    const t = setup();
    expect(await sendTest(t.deps, { ...ok, to: { kind: "employee", employeeId: ID.gone } })).toEqual({ ok: false, error: "That person isn't an active employee" });
    expect(await sendTest(t.deps, { ...ok, to: { kind: "employee", employeeId: ID.nobody } })).toEqual({ ok: false, error: "That person isn't an active employee" });
    expect(await sendTest(t.deps, { ...ok, subject: person(ID.gone), to: { kind: "subject" } })).toEqual({ ok: false, error: "That person isn't an active employee" });
    expect(await sendTest(t.deps, { ...ok, subject: person(ID.nobody) })).toMatchObject({ ok: false });
    expect(t.posts).toHaveLength(0);
  });

  it("says so when there is nothing to send (daily with no usage)", async () => {
    const t = setup();
    const r = await sendTest(t.deps, { ...ok, cadence: "daily", periodKey: "2026-09-26" });
    expect(r).toEqual({ ok: false, error: "Nothing to send for that period (no usage)" });
    expect(t.posts).toHaveLength(0);
  });

  it("says so when the target has no Slack account", async () => {
    const t = setup({ employees: employees.map((e) => (e.id === ID.rep ? { ...e, email: "alex@elsewhere.com" } : e)) });
    const r = await sendTest(t.deps, { ...ok, to: { kind: "employee", employeeId: ID.rep } });
    expect(r).toEqual({ ok: false, error: "No Slack account found for Alex Kim" });
    expect(t.posts).toHaveLength(0);
  });

  it("returns a Slack failure as an error instead of throwing", async () => {
    const t = setup({ slack: { postMessage: async () => { throw new SlackApiError("chat.postMessage", "channel_not_found"); } } });
    expect(await sendTest(t.deps, ok)).toEqual({ ok: false, error: "Slack chat.postMessage: channel_not_found" });
  });

  it("reports an unknown outcome distinctly so the admin does not blindly resend", async () => {
    const t = setup({ slack: { postMessage: async () => { throw new SlackApiError("chat.postMessage", "internal_error"); } } });
    const r = await sendTest(t.deps, ok);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("outcome unknown");
  });
});
