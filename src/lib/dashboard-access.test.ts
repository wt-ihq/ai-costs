import { describe, expect, it } from "vitest";
import { canAccessDashboard, dashboardAccessFor, isAccessRole, normalizeAccessEmail, parseAdminEmails, resolveDashboardAccess } from "./dashboard-access";

describe("canAccessDashboard", () => {
  const list = new Set(["ana@intenthq.com"]);

  it("always lets admins in, even when the list could not be read", () => {
    expect(canAccessDashboard({ isAdmin: true, email: "boss@intenthq.com", allowlist: list })).toBe(true);
    expect(canAccessDashboard({ isAdmin: true, email: "boss@intenthq.com", allowlist: null })).toBe(true);
  });

  it("lets listed people in, whatever the case of their sign-in email", () => {
    expect(canAccessDashboard({ isAdmin: false, email: "Ana@IntentHQ.com", allowlist: list })).toBe(true);
  });

  it("keeps everyone else out", () => {
    expect(canAccessDashboard({ isAdmin: false, email: "bob@intenthq.com", allowlist: list })).toBe(false);
    expect(canAccessDashboard({ isAdmin: false, email: null, allowlist: list })).toBe(false);
  });

  it("fails closed when the list could not be read", () => {
    expect(canAccessDashboard({ isAdmin: false, email: "ana@intenthq.com", allowlist: null })).toBe(false);
  });
});

describe("dashboardAccessFor", () => {
  it("answers per email from ADMIN_EMAILS plus the list", () => {
    const can = dashboardAccessFor(["boss@intenthq.com"], new Set(["ana@intenthq.com"]));
    expect(can("boss@intenthq.com")).toBe(true);
    expect(can("ana@intenthq.com")).toBe(true);
    expect(can("bob@intenthq.com")).toBe(false);
  });

  it("with an unreadable list, only admins", () => {
    const can = dashboardAccessFor(["boss@intenthq.com"], null);
    expect(can("BOSS@intenthq.com")).toBe(true);
    expect(can("ana@intenthq.com")).toBe(false);
  });
});

describe("normalizeAccessEmail", () => {
  it("trims and lowercases a company address", () => {
    expect(normalizeAccessEmail("  Ana.Smith@IntentHQ.com ")).toBe("ana.smith@intenthq.com");
  });

  it("rejects anything that can't sign in", () => {
    for (const bad of ["ana@gmail.com", "ana@intenthq.com.evil.io", "@intenthq.com", "ana", "a b@intenthq.com", "", 42, null, undefined]) {
      expect(normalizeAccessEmail(bad)).toBeNull();
    }
  });
});

describe("parseAdminEmails", () => {
  it("splits, trims, lowercases and drops blanks", () => {
    expect(parseAdminEmails(" A@intenthq.com, ,b@intenthq.com ")).toEqual(["a@intenthq.com", "b@intenthq.com"]);
    expect(parseAdminEmails(undefined)).toEqual([]);
  });
});

describe("resolveDashboardAccess", () => {
  it("ADMIN_EMAILS admins are always admin, whatever the list says (or if it can't be read)", () => {
    for (const listed of [null, "viewer", "admin"] as const) {
      expect(resolveDashboardAccess({ envAdmin: true, listed })).toEqual({ role: "admin", allowed: true });
    }
  });

  it("the list's role applies to everyone else", () => {
    expect(resolveDashboardAccess({ envAdmin: false, listed: "admin" })).toEqual({ role: "admin", allowed: true });
    expect(resolveDashboardAccess({ envAdmin: false, listed: "viewer" })).toEqual({ role: "viewer", allowed: true });
  });

  it("not listed (or the list unreadable): no access, and never admin", () => {
    expect(resolveDashboardAccess({ envAdmin: false, listed: null })).toEqual({ role: "viewer", allowed: false });
  });
});

describe("isAccessRole", () => {
  it("is viewer or admin only", () => {
    expect(isAccessRole("viewer")).toBe(true);
    expect(isAccessRole("admin")).toBe(true);
    for (const bad of ["Admin", "owner", "", null, undefined, 1]) expect(isAccessRole(bad)).toBe(false);
  });
});
