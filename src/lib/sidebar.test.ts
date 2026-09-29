import { describe, expect, it } from "vitest";
import { SIDEBAR_COOKIE, isSidebarCollapsed, sidebarCookie } from "./sidebar";

describe("isSidebarCollapsed", () => {
  it("is collapsed only for the explicit 'collapsed' value", () => {
    expect(isSidebarCollapsed("collapsed")).toBe(true);
    expect(isSidebarCollapsed("expanded")).toBe(false);
  });

  it("defaults to shown when the cookie is missing or unrecognised", () => {
    expect(isSidebarCollapsed(undefined)).toBe(false);
    expect(isSidebarCollapsed("garbage")).toBe(false);
  });
});

describe("sidebarCookie", () => {
  it("serialises the state as a site-wide, year-long cookie the server reads back", () => {
    expect(sidebarCookie(true)).toBe(`${SIDEBAR_COOKIE}=collapsed; path=/; max-age=31536000; samesite=lax`);
    expect(sidebarCookie(false)).toBe(`${SIDEBAR_COOKIE}=expanded; path=/; max-age=31536000; samesite=lax`);
  });

  it("round-trips through isSidebarCollapsed", () => {
    for (const collapsed of [true, false]) {
      const value = sidebarCookie(collapsed).split(";")[0].split("=")[1];
      expect(isSidebarCollapsed(value)).toBe(collapsed);
    }
  });
});
