import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenAICost, OPENAI_BACKOFF_MS } from "./openai";

const WINDOW = { startDate: "2026-10-01", endDate: "2026-10-20" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const limited = (headers: Record<string, string> = {}) =>
  json({ error: { message: "You've exceeded the 30 request(s) every 1 minute(s) rate limit", code: "rate_limit_exceeded" } }, 429, headers);
const page = (n: number, more = false) => json({ data: [{ start_time: n, results: [] }], has_more: more, next_page: more ? `p${n + 1}` : null });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchOpenAICost", () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  const setup = (responses: Response[]) => {
    vi.stubEnv("OPENAI_ADMIN_API_KEY", "sk-admin");
    waits.length = 0;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => { calls.push(String(url)); return responses.shift()!; }));
    return calls;
  };

  it("waits out the per-minute rate limit (another tool shares the org's quota), then succeeds", async () => {
    const calls = setup([limited(), limited(), page(1)]);
    const r = await fetchOpenAICost(WINDOW, { sleep });
    expect(r.data).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([OPENAI_BACKOFF_MS[0], OPENAI_BACKOFF_MS[1]]);
  });

  it("honours Retry-After, capped at a minute", async () => {
    setup([limited({ "retry-after": "7" }), limited({ "retry-after": "600" }), page(1)]);
    await fetchOpenAICost(WINDOW, { sleep });
    expect(waits).toEqual([7_000, 60_000]);
  });

  it("is patient for about three minutes in total, then reports the limit", async () => {
    setup(Array.from({ length: OPENAI_BACKOFF_MS.length + 1 }, () => limited()));
    await expect(fetchOpenAICost(WINDOW, { sleep })).rejects.toThrow(/OpenAI API 429/);
    expect(waits).toEqual([...OPENAI_BACKOFF_MS]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(180_000);
  });

  it("retries server errors too, but not a bad request", async () => {
    setup([json("oops", 503), page(1)]);
    await expect(fetchOpenAICost(WINDOW, { sleep })).resolves.toMatchObject({ data: [{ start_time: 1 }] });
    setup([json({ error: { message: "bad" } }, 400)]);
    await expect(fetchOpenAICost(WINDOW, { sleep })).rejects.toThrow(/OpenAI API 400/);
    expect(waits).toEqual([]);
  });

  it("still follows pages", async () => {
    const calls = setup([page(1, true), page(2)]);
    const r = await fetchOpenAICost(WINDOW, { sleep });
    expect(r.data.map((b) => b.start_time)).toEqual([1, 2]);
    expect(calls[1]).toContain("page=p2");
  });
});
