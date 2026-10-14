import { describe, expect, it } from "vitest";
import type { OktaUser } from "@/lib/ingest/normalizers/okta";
import type { OktaGroupFetcher } from "@/lib/ingest/sources/okta";
import { PEOPLE_GROUPS, peopleGroupIds, planOktaRemovals, scopeOktaUsers } from "./run-okta";

const user = (id: string, status = "ACTIVE"): OktaUser => ({ id, status, profile: { email: `${id}@intenthq.com` } });

describe("peopleGroupIds", () => {
  it("is the Staff and Outsourced Suppliers groups, by exact name", () => {
    expect(PEOPLE_GROUPS).toEqual(["Staff", "Outsourced Suppliers"]);
  });

  it("unions the members of both groups", async () => {
    const asked: string[] = [];
    const fetch: OktaGroupFetcher = async (name) => {
      asked.push(name);
      return name === "Staff" ? [{ email: "a@x", oktaId: "a" }, { email: "b@x", oktaId: "b" }] : [{ email: "c@x", oktaId: "c" }, { email: "b@x", oktaId: "b" }];
    };
    expect([...(await peopleGroupIds(fetch))].sort()).toEqual(["a", "b", "c"]);
    expect(asked).toEqual(["Staff", "Outsourced Suppliers"]);
  });

  it("fails on an empty group rather than dropping everyone", async () => {
    const fetch: OktaGroupFetcher = async (name) => (name === "Staff" ? [{ email: "a@x", oktaId: "a" }] : []);
    await expect(peopleGroupIds(fetch)).rejects.toThrow(/Outsourced Suppliers/);
  });

  it("fails when a group's members carry no Okta ids", async () => {
    await expect(peopleGroupIds(async () => [{ email: "a@x" }])).rejects.toThrow(/Staff/);
  });

  it("passes on a missing or renamed group (the fetcher throws)", async () => {
    await expect(peopleGroupIds(async (name) => { throw new Error(`Okta group "${name}" not found`); })).rejects.toThrow(/not found/);
  });
});

describe("scopeOktaUsers", () => {
  const members = new Set(["member", "member-leaver"]);
  const stored = new Set(["member", "stored-active", "stored-leaver", "stored-suspended"]);
  const ids = (users: OktaUser[]) => users.map((u) => u.id);

  it("keeps group members, whatever their status, and drops everyone else who is active", () => {
    const users = [user("member"), user("member-leaver", "DEPROVISIONED"), user("stored-active"), user("never-stored")];
    expect(ids(scopeOktaUsers(users, members, stored))).toEqual(["member", "member-leaver"]);
  });

  it("still updates stored people who left (Okta may drop them from the group), but never adds a new leaver", () => {
    const users = [user("stored-leaver", "DEPROVISIONED"), user("stored-suspended", "suspended"), user("unknown-leaver", "DEPROVISIONED")];
    expect(ids(scopeOktaUsers(users, members, stored))).toEqual(["stored-leaver", "stored-suspended"]);
  });

  it("drops users without an id", () => {
    expect(scopeOktaUsers([{ status: "ACTIVE", profile: { email: "x@intenthq.com" } }], members, stored)).toEqual([]);
  });
});

describe("planOktaRemovals", () => {
  it("is every stored Okta account this sync didn't write", () => {
    expect(planOktaRemovals(new Set(["a", "b", "c", "d"]), ["a", "b", "c"])).toEqual(["d"]);
  });

  it("refuses to remove more than half of the stored accounts (a wrong group, not a cleanup)", () => {
    expect(() => planOktaRemovals(new Set(["a", "b", "c", "d", "e"]), ["a", "b"])).toThrow(/3 of 5/);
    expect(planOktaRemovals(new Set(["a", "b", "c", "d"]), ["a", "b"])).toEqual(["c", "d"]);
  });

  it("removes nothing when nothing is stored", () => {
    expect(planOktaRemovals(new Set(), ["a"])).toEqual([]);
  });
});
