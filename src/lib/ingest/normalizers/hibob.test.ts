import { describe, expect, it } from "vitest";
import { normalizeHibob, type HibobResponse } from "./hibob";
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
