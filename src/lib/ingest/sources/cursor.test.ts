import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENTS_REQUEST_TIMEOUT_MS, fetchCursorUsageEvents, MAX_EVENT_PAGES } from "./cursor";

const WINDOW = { startDate: "2026-10-26", endDate: "2026-10-29" };
const page = (currentPage: number, numPages: number, hasNextPage = currentPage < numPages) =>
  new Response(
    JSON.stringify({
      usageEvents: [{ timestamp: "1", userEmail: "a@intenthq.com", model: "auto", kind: "Usage-based", chargedCents: currentPage }],
      pagination: { numPages, currentPage, pageSize: 1000, hasNextPage, hasPreviousPage: currentPage > 1 },
    }),
    { status: 200 },
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Stub fetch with canned responses (or a thrower), recording each request's body and init. */
function setup(responses: (Response | (() => never))[]) {
  vi.stubEnv("CURSOR_ADMIN_API_KEY", "key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const calls: { body: Record<string, number>; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)), init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      if (typeof next === "function") next();
      return next as Response;
    }),
  );
  return calls;
}

describe("fetchCursorUsageEvents", () => {
  it("follows pages while Cursor says there are more, and logs each page", async () => {
    const calls = setup([page(1, 3), page(2, 3), page(3, 3)]);
    const r = await fetchCursorUsageEvents(WINDOW);
    expect(r.usageEvents.map((e) => e.chargedCents)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.body.page)).toEqual([1, 2, 3]);
    expect(console.log).toHaveBeenCalledTimes(3);
  });

  it("stops at the last page even when hasNextPage never turns false (30 Oct 2026: the sync spun until Vercel killed it)", async () => {
    const calls = setup([page(1, 2, true), page(2, 2, true)]);
    const r = await fetchCursorUsageEvents(WINDOW);
    expect(r.usageEvents).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("gives up with a clear error rather than paginating forever when the page count is nonsense too", async () => {
    setup(Array.from({ length: MAX_EVENT_PAGES + 1 }, (_, i) => page(i + 1, 10_000, true)));
    await expect(fetchCursorUsageEvents(WINDOW)).rejects.toThrow(/still paginating after 100 pages/);
  });

  it("gives every request a timeout and reports one as a failure instead of hanging", async () => {
    const calls = setup([
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ]);
    await expect(fetchCursorUsageEvents(WINDOW)).rejects.toThrow(/no response within 60 s .*page 1/);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(EVENTS_REQUEST_TIMEOUT_MS).toBe(60_000);
  });
});
