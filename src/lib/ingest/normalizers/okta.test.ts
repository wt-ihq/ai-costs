import { describe, expect, it } from "vitest";
import { normalizeOkta, type OktaUsersResponse } from "./okta";
import { oktaUsersFixture } from "@/lib/ingest/fixtures/okta";
import { parseNextLink } from "@/lib/ingest/sources/okta";
import { SchemaDriftError } from "@/lib/ingest/types";

describe("normalizeOkta", () => {
  it("maps Okta users to employee rows keyed by lowercased email", () => {
    const rows = normalizeOkta(oktaUsersFixture);
    // 3 real users; the no-email service account is skipped.
    expect(rows).toHaveLength(3);
    const gareth = rows.find((r) => r.email === "gareth.jones@intenthq.com")!;
    expect(gareth).toMatchObject({
      okta_id: "00u1",
      email: "gareth.jones@intenthq.com",
      full_name: "Gareth Jones", // derived from first/last
      department: "Engineering",
      employment_status: "active",
      start_date: "2019-04-01",
      leave_date: null,
    });
  });

  it("prefers displayName when present", () => {
    const tom = normalizeOkta(oktaUsersFixture).find((r) => r.email === "tom.reeve@intenthq.com")!;
    expect(tom.full_name).toBe("Tom Reeve");
  });

  it("retains deprovisioned leavers and stamps leave_date so spend stays attributed", () => {
    const leaver = normalizeOkta(oktaUsersFixture).find((r) => r.email === "leaver@intenthq.com")!;
    expect(leaver).toMatchObject({ employment_status: "deprovisioned", leave_date: "2026-03-31" });
  });

  it("skips accounts with no email rather than failing the whole sync", () => {
    const rows = normalizeOkta(oktaUsersFixture);
    expect(rows.some((r) => r.okta_id === "00u4")).toBe(false);
  });

  it("throws on schema drift (missing users array)", () => {
    expect(() => normalizeOkta({} as OktaUsersResponse)).toThrow(SchemaDriftError);
  });

  it("throws when no usable users are present", () => {
    expect(() => normalizeOkta({ users: [{ id: "x", profile: {} }] })).toThrow(SchemaDriftError);
  });
});

describe("parseNextLink", () => {
  it("extracts the rel=next URL from Okta's Link header", () => {
    const header = '<https://x.okta.com/api/v1/users?after=a1>; rel="self", <https://x.okta.com/api/v1/users?after=b2>; rel="next"';
    expect(parseNextLink(header)).toBe("https://x.okta.com/api/v1/users?after=b2");
  });

  it("returns null when there is no next page", () => {
    expect(parseNextLink('<https://x.okta.com/api/v1/users?after=a1>; rel="self"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});
