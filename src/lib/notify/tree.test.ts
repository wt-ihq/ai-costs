import { describe, expect, it } from "vitest";
import { buildReportingTree } from "./tree";
import type { NotifyEmployee } from "./types";

const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: id.toUpperCase(), department: "Eng", oktaId: `00u${id}`,
  employeeNumber: null, managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});

describe("buildReportingTree", () => {
  it("returns direct and indirect reports, never the manager", () => {
    const t = buildReportingTree([
      emp("ceo"),
      emp("cto", { managerRef: "00uceo" }),
      emp("dev", { managerRef: "00ucto" }),
      emp("intern", { managerRef: "00udev" }),
    ]);
    expect(t.reportsOf("cto").sort()).toEqual(["dev", "intern"]);
    expect(t.reportsOf("ceo").sort()).toEqual(["cto", "dev", "intern"]);
    expect(t.reportsOf("intern")).toEqual([]);
    expect(t.managerOf("dev")).toBe("cto");
  });

  it("resolves managerRef by Okta id, email or employee number, case-insensitively", () => {
    const t = buildReportingTree([
      emp("m", { employeeNumber: "1001" }),
      emp("a", { managerRef: "00uM" }), // okta id, different case
      emp("b", { managerRef: "M@X.COM" }), // email
      emp("c", { managerRef: "1001" }), // employee number
    ]);
    expect(t.reportsOf("m").sort()).toEqual(["a", "b", "c"]);
  });

  it("never makes a manager a report in an A→B→A cycle, and flags both as unresolved", () => {
    const t = buildReportingTree([emp("a", { managerRef: "00ub" }), emp("b", { managerRef: "00ua" }), emp("s", { managerRef: "00us" })]);
    expect(t.reportsOf("a")).toEqual([]);
    expect(t.reportsOf("b")).toEqual([]);
    expect(t.reportsOf("s")).toEqual([]);
    expect(t.managerOf("s")).toBeNull();
    expect(t.unresolved.sort()).toEqual(["a", "b", "s"]);
  });

  it("handles a longer A→B→C→A cycle: no member sees another, a report hanging off it still rolls up", () => {
    const t = buildReportingTree([
      emp("a", { managerRef: "00ub" }),
      emp("b", { managerRef: "00uc" }),
      emp("c", { managerRef: "00ua" }),
      emp("d", { managerRef: "00ua" }), // reports to a cycle member, not in the cycle itself
      emp("x", { managerRef: "00uc", leaveDate: "2026-01-31", employmentStatus: "deprovisioned" }),
    ]);
    expect(t.reportsOf("a")).toEqual(["d"]);
    expect(t.reportsOf("b")).toEqual([]);
    expect(t.reportsOf("c").sort()).toEqual(["x"]);
    expect(t.reportsOf("d")).toEqual([]);
    expect(t.unresolved.sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps leavers as descendants but lists only ACTIVE people without a resolvable manager", () => {
    const t = buildReportingTree([
      emp("m"),
      emp("gone", { managerRef: "00um", leaveDate: "2026-03-31", employmentStatus: "deprovisioned" }),
      emp("lost", { managerRef: "nobody@x.com" }),
      emp("oldleaver", { leaveDate: "2025-01-01" }),
    ]);
    expect(t.reportsOf("m")).toEqual(["gone"]);
    expect(t.unresolved.sort()).toEqual(["lost", "m"]);
  });
});
