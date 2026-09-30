import { describe, expect, it } from "vitest";
import { isActiveEmployee, isCadence, isUuid, notifyMode, toNotifyEmployee } from "./types";

describe("notifyMode", () => {
  it("defaults to off unless explicitly preview or live", () => {
    expect(notifyMode({})).toBe("off");
    expect(notifyMode({ SLACK_NOTIFY_MODE: "LIVE " })).toBe("live");
    expect(notifyMode({ SLACK_NOTIFY_MODE: "preview" })).toBe("preview");
    expect(notifyMode({ SLACK_NOTIFY_MODE: "on" })).toBe("off");
  });
});

describe("input guards (server actions receive arbitrary input)", () => {
  it("accepts only known cadences", () => {
    expect(isCadence("weekly")).toBe(true);
    expect(isCadence("hourly")).toBe(false);
    expect(isCadence(3)).toBe(false);
  });
  it("accepts only uuids", () => {
    expect(isUuid("0b7c7f5e-9d2a-4c1e-8f3a-2a6b9c1d4e5f")).toBe(true);
    expect(isUuid("1; drop table")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe("toNotifyEmployee / isActiveEmployee", () => {
  it("maps a DB row and treats leavers as inactive", () => {
    const e = toNotifyEmployee({
      id: "e1", email: "A@X.COM", full_name: "Ann", department: "Eng", okta_id: "00u9",
      employee_number: null, manager_ref: "00u1", employment_status: "active", leave_date: null,
    });
    expect(e).toEqual({
      id: "e1", email: "a@x.com", fullName: "Ann", department: "Eng", oktaId: "00u9",
      employeeNumber: null, managerRef: "00u1", employmentStatus: "active", leaveDate: null,
    });
    expect(isActiveEmployee(e)).toBe(true);
    expect(isActiveEmployee({ ...e, leaveDate: "2026-03-31" })).toBe(false);
    expect(isActiveEmployee({ ...e, employmentStatus: "DEPROVISIONED" })).toBe(false);
    expect(isActiveEmployee({ ...e, employmentStatus: "leaver" })).toBe(false); // legacy HiBob rows
  });
});
