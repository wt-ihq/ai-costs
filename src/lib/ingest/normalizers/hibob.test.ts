import { describe, expect, it } from "vitest";
import { normalizeHibob, buildNamedListMap, resolveDepartments, type HibobResponse } from "./hibob";
import { SchemaDriftError } from "@/lib/ingest/types";

const raw: HibobResponse = {
  employees: [
    {
      id: "H001",
      email: "Gareth.Jones@intenthq.com",
      displayName: "Gareth Jones",
      work: { department: "Engineering", site: "London" },
      employmentStatus: "Active",
      startDate: "2019-04-01",
    },
    {
      id: "H002",
      email: "leaver@intenthq.com",
      displayName: "Former Person",
      work: { department: "Sales" },
      employmentStatus: "Terminated",
      leaveDate: "2026-03-31",
    },
  ],
};

describe("normalizeHibob", () => {
  it("maps people to employee upserts, lowercasing email", () => {
    const out = normalizeHibob(raw);
    expect(out[0]).toEqual({
      hibob_id: "H001",
      email: "gareth.jones@intenthq.com",
      full_name: "Gareth Jones",
      department: "Engineering",
      site: "London",
      employment_status: "Active",
      start_date: "2019-04-01",
      leave_date: null,
    });
  });

  it("retains leavers with a leave_date", () => {
    expect(normalizeHibob(raw)[1]).toMatchObject({
      employment_status: "Terminated",
      leave_date: "2026-03-31",
    });
  });

  it("throws on schema drift", () => {
    expect(() => normalizeHibob({} as never)).toThrow(SchemaDriftError);
  });
});

describe("department resolution", () => {
  const list = {
    name: "department",
    values: [
      { id: "251690516", value: "Applied Data Science", name: "Applied Data Science" },
      { id: "252235672", value: "Client Success", name: "Client Success" },
    ],
  };

  it("builds an id→name map from a named-list", () => {
    const map = buildNamedListMap(list);
    expect(map.get("251690516")).toBe("Applied Data Science");
  });

  it("resolves department IDs to names, leaving already-named values alone", () => {
    const emps = [
      { hibob_id: "1", email: "a@x.com", full_name: "A", department: "251690516", site: null, employment_status: null, start_date: null, leave_date: null },
      { hibob_id: "2", email: "b@x.com", full_name: "B", department: "Human Resources", site: null, employment_status: null, start_date: null, leave_date: null },
    ];
    const out = resolveDepartments(emps, buildNamedListMap(list));
    expect(out[0].department).toBe("Applied Data Science");
    expect(out[1].department).toBe("Human Resources"); // unknown id/name passes through
  });
});
