import { describe, expect, it } from "vitest";
import { createSlackClient, SlackApiError } from "./slack-client";

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (Response | ((c: Call) => Response))[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${c.url}`);
    return typeof next === "function" ? next(c) : next;
  }) as typeof fetch;
  return { fn, calls };
}
const ok = (body: object) => new Response(JSON.stringify({ ok: true, ...body }), { status: 200 });
const fail = (error: string) => new Response(JSON.stringify({ ok: false, error }), { status: 200 });
const form = (c: Call) => new URLSearchParams(String(c.init.body));

describe("createSlackClient", () => {
  it("looks users up by email; users_not_found is null, not an error", async () => {
    const f = fakeFetch([ok({ user: { id: "U1" } }), fail("users_not_found")]);
    const slack = createSlackClient("xoxb-t", { fetch: f.fn });
    expect(await slack.lookupUserByEmail("a@x.com")).toBe("U1");
    expect(await slack.lookupUserByEmail("b@x.com")).toBeNull();
    expect(f.calls[0].url).toBe("https://slack.com/api/users.lookupByEmail");
    expect(form(f.calls[0]).get("email")).toBe("a@x.com");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-t");
  });

  it("throws SlackApiError with the Slack error code", async () => {
    const slack = createSlackClient("t", { fetch: fakeFetch([fail("channel_not_found")]).fn });
    await expect(slack.openDm("U1")).rejects.toMatchObject({ name: "SlackApiError", method: "conversations.open", code: "channel_not_found" });
  });

  it("waits Retry-After on 429 and retries, up to 3 times", async () => {
    const slept: number[] = [];
    const limited = () => new Response("", { status: 429, headers: { "retry-after": "2" } });
    const f = fakeFetch([limited(), ok({ channel: { id: "D1" } })]);
    const slack = createSlackClient("t", { fetch: f.fn, sleep: async (ms) => void slept.push(ms) });
    expect(await slack.openDm("U1")).toBe("D1");
    expect(slept).toEqual([2000]);

    const g = fakeFetch([limited(), limited(), limited(), limited()]);
    const s2 = createSlackClient("t", { fetch: g.fn, sleep: async () => {} });
    await expect(s2.openDm("U1")).rejects.toMatchObject({ code: "http_429" });
  });

  it("uploads an image in three steps and returns the file id", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const f = fakeFetch([
      ok({ upload_url: "https://files.slack.com/upload/abc", file_id: "F1" }),
      new Response("OK", { status: 200 }),
      ok({ files: [{ id: "F1" }] }),
    ]);
    const slack = createSlackClient("t", { fetch: f.fn });
    expect(await slack.uploadImage(png, "you.png", "YOU · USAGE")).toBe("F1");
    expect(form(f.calls[0]).get("length")).toBe("4");
    expect(f.calls[1].url).toBe("https://files.slack.com/upload/abc");
    expect(f.calls[1].init.body).toBe(png);
    expect(JSON.parse(form(f.calls[2]).get("files")!)).toEqual([{ id: "F1", title: "YOU · USAGE" }]);
  });

  it("posts blocks as JSON with unfurls off and returns the ts", async () => {
    const f = fakeFetch([ok({ ts: "1727.1" })]);
    const slack = createSlackClient("t", { fetch: f.fn });
    expect(await slack.postMessage("D1", [{ type: "divider" }], "hi")).toBe("1727.1");
    const p = form(f.calls[0]);
    expect([p.get("channel"), p.get("text"), p.get("blocks"), p.get("unfurl_links")]).toEqual(["D1", "hi", '[{"type":"divider"}]', "false"]);
  });

  it("is an Error subclass callers can branch on", () => {
    expect(new SlackApiError("chat.postMessage", "invalid_blocks")).toBeInstanceOf(Error);
  });
});
