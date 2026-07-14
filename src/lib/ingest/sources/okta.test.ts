import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOktaGroupMembers } from "./okta";

/** Minimal fetch Response stub with an optional Link header. */
const jsonRes = (body: unknown, link?: string) =>
  ({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "link" ? link ?? null : null) },
    json: async () => body,
    text: async () => "",
  }) as unknown as Response;

const stubEnv = () => {
  vi.stubEnv("OKTA_ORG_URL", "https://example.okta.com");
  vi.stubEnv("OKTA_API_TOKEN", "tok");
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchOktaGroupMembers", () => {
  it("resolves the exact-name group among prefix matches and pages members via Link", async () => {
    stubEnv();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/api/v1/groups?")) {
        // `q=` prefix-matches: a look-alike group must be filtered out by exact name.
        return jsonRes([
          { id: "g1", profile: { name: "access-chatgpt-admins" } },
          { id: "g2", profile: { name: "access-chatgpt" } },
        ]);
      }
      if (url.includes("/groups/g2/users") && !url.includes("after=")) {
        return jsonRes(
          [{ profile: { email: "Alex.Morgan@intenthq.com" } }],
          '<https://example.okta.com/api/v1/groups/g2/users?after=xyz&limit=200>; rel="next"',
        );
      }
      if (url.includes("after=xyz")) {
        return jsonRes([{ profile: { login: "jamie.lee@intenthq.com" } }, { profile: {} }]);
      }
      throw new Error(`unexpected url ${url}`);
    }));

    const members = await fetchOktaGroupMembers("access-chatgpt");
    expect(members).toEqual([
      { email: "alex.morgan@intenthq.com" }, // lowercased
      { email: "jamie.lee@intenthq.com" },   // login fallback; empty profile dropped
    ]);
    expect(calls.some((u) => u.includes("/groups/g2/users"))).toBe(true);
    expect(calls.some((u) => u.includes("/groups/g1/"))).toBe(false); // look-alike never fetched
  });

  it("follows pagination on the groups listing before filtering by exact name", async () => {
    stubEnv();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/api/v1/groups?") && !url.includes("after=")) {
        // Page 1: only the look-alike group; the exact match is on page 2.
        return jsonRes(
          [{ id: "g1", profile: { name: "access-chatgpt-admins" } }],
          '<https://example.okta.com/api/v1/groups?q=access-chatgpt&limit=100&after=g2>; rel="next"',
        );
      }
      if (url.includes("/api/v1/groups?") && url.includes("after=g2")) {
        // Page 2: the exact-name match.
        return jsonRes([{ id: "g2", profile: { name: "access-chatgpt" } }]);
      }
      if (url.includes("/groups/g2/users")) {
        return jsonRes([{ profile: { email: "Alex.Morgan@intenthq.com" } }]);
      }
      throw new Error(`unexpected url ${url}`);
    }));

    const members = await fetchOktaGroupMembers("access-chatgpt");
    expect(members).toEqual([{ email: "alex.morgan@intenthq.com" }]);
    expect(calls.some((u) => u.includes("/groups/g2/users"))).toBe(true);
  });

  it("throws when the group is not found", async () => {
    stubEnv();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes([{ id: "g1", profile: { name: "other" } }])));
    await expect(fetchOktaGroupMembers("access-chatgpt")).rejects.toThrow(/not found/i);
  });

  it("throws when multiple groups share the exact name", async () => {
    stubEnv();
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonRes([
        { id: "g1", profile: { name: "access-chatgpt" } },
        { id: "g2", profile: { name: "access-chatgpt" } },
      ]),
    ));
    await expect(fetchOktaGroupMembers("access-chatgpt")).rejects.toThrow(/ambiguous/i);
  });

  it("throws when env vars are missing", async () => {
    // Explicitly blank (not merely unstubbed) so a dev shell exporting real
    // Okta vars can't turn this into a live network call.
    vi.stubEnv("OKTA_ORG_URL", "");
    vi.stubEnv("OKTA_API_TOKEN", "");
    await expect(fetchOktaGroupMembers("access-chatgpt")).rejects.toThrow(/OKTA_ORG_URL/);
  });
});
