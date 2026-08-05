import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenRouterActivity, fetchOpenRouterAnalytics } from "./openrouter";

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => headers[k] ?? null },
  }) as unknown as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const WINDOW = { startDate: "2026-07-01", endDate: "2026-08-01" };
const stubKey = () => vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "mk-test");

describe("fetchOpenRouterAnalytics", () => {
  it("POSTs the day-granularity user×model query with the window and bearer auth", async () => {
    stubKey();
    let seenUrl = "", seenAuth = "", seenBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>).Authorization;
      seenBody = JSON.parse(init.body as string);
      return jsonRes({ data: { data: [], metadata: { truncated: false } } });
    }));

    await fetchOpenRouterAnalytics(WINDOW);

    expect(seenUrl).toBe("https://openrouter.ai/api/v1/analytics/query");
    expect(seenAuth).toBe("Bearer mk-test");
    expect(seenBody.metrics).toEqual(["total_usage", "tokens_total", "request_count"]);
    expect(seenBody.dimensions).toEqual(["user", "model"]);
    expect(seenBody.granularity).toBe("day");
    expect(seenBody.time_range).toEqual({ start: "2026-07-01T00:00:00Z", end: "2026-08-01T00:00:00Z" });
  });

  it("throws (rather than returns partial data) when the response is truncated", async () => {
    stubKey();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ data: { data: [], metadata: { truncated: true, row_count: 10000 } } })));
    await expect(fetchOpenRouterAnalytics(WINDOW)).rejects.toThrow(/truncated/);
  });

  it("retries 429 honoring Retry-After, then succeeds", async () => {
    stubKey();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () =>
      ++calls < 3
        ? jsonRes({ error: { code: 429, message: "slow down" } }, 429, { "Retry-After": "0" })
        : jsonRes({ data: { data: [] } }),
    ));
    await fetchOpenRouterAnalytics(WINDOW);
    expect(calls).toBe(3);
  });

  it("throws on a non-retryable status without retrying", async () => {
    stubKey();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls++; return jsonRes({ error: { code: 403, message: "management key required" } }, 403); }));
    await expect(fetchOpenRouterAnalytics(WINDOW)).rejects.toThrow(/403/);
    expect(calls).toBe(1);
  });

  it("throws when OPENROUTER_MANAGEMENT_KEY is missing", async () => {
    vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "");
    await expect(fetchOpenRouterAnalytics(WINDOW)).rejects.toThrow(/OPENROUTER_MANAGEMENT_KEY/);
  });
});

describe("fetchOpenRouterActivity", () => {
  it("GETs /activity with bearer auth", async () => {
    stubKey();
    let seenUrl = "", seenAuth = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>).Authorization;
      return jsonRes({ data: [] });
    }));
    await fetchOpenRouterActivity();
    expect(seenUrl).toBe("https://openrouter.ai/api/v1/activity");
    expect(seenAuth).toBe("Bearer mk-test");
  });
});
