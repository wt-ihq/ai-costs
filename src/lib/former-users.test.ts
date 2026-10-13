import { describe, expect, it } from "vitest";
import { buildFormerUserRow, FORMER_USERS_TEAM, ownerOverrideTarget } from "./former-users";
import { isActiveEmployee } from "./notify/types";

const base = { name: "Rekha Thalla", email: "Rekha.Thalla@IntentHQ.com ", team: "", left: "" };
const depts = ["Engineering", "Sales"];

describe("buildFormerUserRow", () => {
  it("defaults the team to Former users and lowercases the email", () => {
    const r = buildFormerUserRow(base, depts, []);
    expect(r).toEqual({
      ok: true,
      row: {
        email: "rekha.thalla@intenthq.com",
        full_name: "Rekha Thalla",
        department: FORMER_USERS_TEAM,
        employment_status: "leaver",
        leave_date: null,
        okta_id: null,
        hibob_id: null,
      },
    });
  });
  it("accepts a known department and maps the month to the 1st", () => {
    const r = buildFormerUserRow({ ...base, team: "Sales", left: "2026-03" }, depts, []);
    expect(r.ok && r.row.department).toBe("Sales");
    expect(r.ok && r.row.leave_date).toBe("2026-03-01");
  });
  it("accepts Former users explicitly", () => {
    expect(buildFormerUserRow({ ...base, team: FORMER_USERS_TEAM }, depts, []).ok).toBe(true);
  });
  it("rejects an unknown team", () => {
    expect(buildFormerUserRow({ ...base, team: "Nope" }, depts, []).ok).toBe(false);
  });
  it("rejects bad emails", () => {
    for (const email of ["", "nope", "a@b", "a b@c.com"]) {
      expect(buildFormerUserRow({ ...base, email }, depts, []).ok).toBe(false);
    }
  });
  it("rejects a duplicate email, case-insensitively", () => {
    const r = buildFormerUserRow(base, depts, ["REKHA.THALLA@intenthq.com"]);
    expect(r).toEqual({ ok: false, error: "That email already exists — pick them from the list" });
  });
  it("rejects bad months", () => {
    for (const left of ["2026-13", "2026-00", "26-03", "2026-3", "2026-03-01", "abc"]) {
      expect(buildFormerUserRow({ ...base, left }, depts, []).ok).toBe(false);
    }
  });
  it("rejects empty or over-long names", () => {
    expect(buildFormerUserRow({ ...base, name: "  " }, depts, []).ok).toBe(false);
    expect(buildFormerUserRow({ ...base, name: "x".repeat(201) }, depts, []).ok).toBe(false);
  });
  it("produces a row that isActiveEmployee treats as inactive", () => {
    for (const left of ["", "2026-03"]) {
      const r = buildFormerUserRow({ ...base, left }, depts, []);
      if (!r.ok) throw new Error(r.error);
      expect(isActiveEmployee({ employmentStatus: r.row.employment_status, leaveDate: r.row.leave_date })).toBe(false);
    }
  });
});

describe("ownerOverrideTarget", () => {
  it("anthropic keys -> api_keys", () => {
    expect(ownerOverrideTarget("anthropic", "apikey_1")).toEqual({ table: "api_keys", column: "external_key_id", conflict: "vendor,external_key_id" });
  });
  it("openai projects -> projects", () => {
    expect(ownerOverrideTarget("openai", "proj_1")).toEqual({ table: "projects", column: "external_id", conflict: "vendor,external_id" });
  });
  it("openai org and other sources -> null", () => {
    expect(ownerOverrideTarget("openai", "org")).toBeNull();
    for (const s of ["cursor", "claude_team", "chatgpt_business", "openrouter", "vercel", "other"] as const) {
      expect(ownerOverrideTarget(s, "x")).toBeNull();
    }
  });
});
