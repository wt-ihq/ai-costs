import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVercelCharges } from "./vercel";
import { SchemaDriftError } from "@/lib/ingest/types";

const textRes = (body: string, status = 200) =>
  ({ ok: status < 400, status, text: async () => body }) as unknown as Response;

const stubEnv = () => {
  vi.stubEnv("VERCEL_BILLING_TOKEN", "tok");
  vi.stubEnv("VERCEL_TEAM_ID", "team_x");
};
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const WINDOW = { startDate: "2026-07-01", endDate: "2026-08-01" };

describe("fetchVercelCharges", () => {
  it("parses the JSONL stream and passes window/team/auth", async () => {
    stubEnv();
    let seenUrl = "", seenAuth = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>).Authorization;
      return textRes('{"BilledCost":1}\n\n{"BilledCost":2}\n');
    }));
    const charges = await fetchVercelCharges(WINDOW);
    expect(charges.map((c) => c.BilledCost)).toEqual([1, 2]); // blank lines skipped
    expect(seenUrl).toContain("from=2026-07-01");
    expect(seenUrl).toContain("to=2026-08-01");
    expect(seenUrl).toContain("teamId=team_x");
    expect(seenAuth).toBe("Bearer tok");
  });

  it("throws SchemaDriftError on a malformed JSONL line", async () => {
    stubEnv();
    vi.stubGlobal("fetch", vi.fn(async () => textRes('{"BilledCost":1}\nnot-json\n')));
    await expect(fetchVercelCharges(WINDOW)).rejects.toThrow(SchemaDriftError);
  });

  it("retries 429/5xx with backoff, then succeeds", async () => {
    stubEnv();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++calls < 3 ? textRes("rate limited", 429) : textRes('{"BilledCost":1}'))));
    const charges = await fetchVercelCharges(WINDOW);
    expect(charges).toHaveLength(1);
    expect(calls).toBe(3);
  }, 15_000);

  it("throws when env vars are missing", async () => {
    vi.stubEnv("VERCEL_BILLING_TOKEN", "");
    vi.stubEnv("VERCEL_TEAM_ID", "");
    await expect(fetchVercelCharges(WINDOW)).rejects.toThrow(/VERCEL_BILLING_TOKEN/);
  });
});
