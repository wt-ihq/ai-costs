import { describe, expect, it } from "vitest";
import { canRetakeClaim, MAX_SEND_ATTEMPTS, toFixedCostSettings } from "./store";

describe("canRetakeClaim", () => {
  it("only retakes FAILED rows that still have attempts left", () => {
    expect(canRetakeClaim({ status: "failed", attempts: 1 })).toBe(true);
    expect(canRetakeClaim({ status: "failed", attempts: MAX_SEND_ATTEMPTS })).toBe(false);
    for (const status of ["sent", "skipped", "pending"]) expect(canRetakeClaim({ status, attempts: 1 })).toBe(false);
  });
});

describe("toFixedCostSettings", () => {
  it("maps notification_settings rows; no org row means exclude", () => {
    expect(toFixedCostSettings([])).toEqual({ orgInclude: false, departments: {}, employees: {} });
    expect(
      toFixedCostSettings([
        { scope: "org", scope_key: "", include_fixed: true },
        { scope: "department", scope_key: "Design", include_fixed: false },
        { scope: "employee", scope_key: "e1", include_fixed: true },
      ]),
    ).toEqual({ orgInclude: true, departments: { Design: false }, employees: { e1: true } });
  });
});
