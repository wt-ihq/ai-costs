import { describe, expect, it } from "vitest";
import { branchIds, buildOrgTree, managersIn, type OrgNode } from "./org-tree";
import { buildReportingTree } from "./tree";
import type { Cadence, NotifyEmployee } from "./types";

const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: id.toUpperCase(), department: "Eng", oktaId: `00u${id}`,
  employeeNumber: null, managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});

const people = [
  emp("ceo", { department: "Leadership" }),
  emp("cto", { managerRef: "00uceo" }),
  emp("dev", { managerRef: "00ucto" }),
  emp("intern", { managerRef: "00udev" }),
  emp("pa", { managerRef: "00uceo", department: null }),
  emp("gone", { managerRef: "00ucto", employmentStatus: "deprovisioned", leaveDate: "2026-09-01" }),
  emp("solo"), // no manager, no reports
  emp("loop1", { managerRef: "00uloop2" }), // a reporting loop: neither is ever a top
  emp("loop2", { managerRef: "00uloop1" }),
];
const subs = new Map<string, Cadence[]>([["cto", ["weekly"]], ["intern", ["daily", "monthly"]]]);
const company = new Map<string, Cadence[]>([["ceo", ["monthly"]]]);
const org = buildOrgTree(people, buildReportingTree(people), subs, company);
const find = (nodes: OrgNode[], id: string): OrgNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = find(n.children, id);
    if (hit) return hit;
  }
};

describe("buildOrgTree", () => {
  it("starts from the top of each reporting line; leavers are left out", () => {
    expect(org.roots.map((r) => r.id)).toEqual(["ceo"]);
    const ceo = org.roots[0];
    expect(ceo.children.map((c) => c.id)).toEqual(["cto", "pa"]); // by name
    expect(find(org.roots, "cto")!.children.map((c) => c.id)).toEqual(["dev"]);
    expect(find(org.roots, "gone")).toBeUndefined();
  });

  it("counts direct reports and everyone below (active only)", () => {
    expect(find(org.roots, "ceo")).toMatchObject({ directCount: 2, totalCount: 4 });
    expect(find(org.roots, "cto")).toMatchObject({ directCount: 1, totalCount: 2 });
    expect(find(org.roots, "intern")).toMatchObject({ directCount: 0, totalCount: 0 });
  });

  it("groups people with no manager in Okta, and anyone caught in a reporting loop, apart", () => {
    expect(org.noManager.map((n) => n.id)).toEqual(["loop1", "loop2", "solo"]);
    expect(org.noManager.every((n) => n.children.length === 0)).toBe(true);
  });

  it("knows the managers and the managers of managers", () => {
    expect(org.managerIds.sort()).toEqual(["ceo", "cto", "dev"]);
    expect(org.seniorIds.sort()).toEqual(["ceo", "cto"]);
  });

  it("shows each person's current digest and company-report cadences", () => {
    expect(find(org.roots, "cto")!.personal).toEqual(["weekly"]);
    expect(find(org.roots, "intern")!.personal).toEqual(["daily", "monthly"]);
    expect(find(org.roots, "ceo")!.company).toEqual(["monthly"]);
    expect(find(org.roots, "pa")).toMatchObject({ personal: [], team: null });
  });
});

describe("selection helpers", () => {
  const ceo = org.roots[0];
  it("a branch is the person and everyone below them", () => {
    expect(branchIds(ceo).sort()).toEqual(["ceo", "cto", "dev", "intern", "pa"]);
    expect(branchIds(find(org.roots, "intern")!)).toEqual(["intern"]);
  });

  it("managers below: the person plus the managers in their branch", () => {
    expect(managersIn(ceo).sort()).toEqual(["ceo", "cto", "dev"]);
    expect(managersIn(find(org.roots, "dev")!)).toEqual(["dev"]);
  });
});
