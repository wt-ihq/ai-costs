import { describe, expect, it } from "vitest";
import { parseClaudeRoster } from "./claude-roster";

const csv = [
  "Name,Email,Role,Status,Seat Tier",
  "Gareth Jones,gareth.jones@intenthq.com,Primary Owner,Active,Premium",
  "Tom Reeve,tom.reeve@intenthq.com,User,Active,Standard",
  "Javier Pedreira,javier.pedreira@intenthq.com,User,Active,Unassigned",
].join("\n");

describe("parseClaudeRoster", () => {
  it("parses roster rows into seats with normalized tiers", () => {
    const { seats, errors } = parseClaudeRoster(csv);
    expect(errors).toEqual([]);
    expect(seats).toHaveLength(3);
    expect(seats[0]).toMatchObject({
      email: "gareth.jones@intenthq.com",
      fullName: "Gareth Jones",
      seatType: "premium",
    });
    expect(seats.map((s) => s.seatType)).toEqual(["premium", "standard", "unassigned"]);
  });

  it("flags rows with an invalid email but keeps the good ones", () => {
    const bad = "Name,Email,Role,Status,Seat Tier\nNo Email,,User,Active,Standard";
    const { seats, errors } = parseClaudeRoster(bad);
    expect(seats).toHaveLength(0);
    expect(errors[0].message).toMatch(/invalid email/);
  });

  it("rejects a file missing required columns", () => {
    const { errors } = parseClaudeRoster("foo,bar\n1,2");
    expect(errors[0].message).toMatch(/missing required columns/);
  });

  it("parses the real QUOTED export (every field wrapped in double quotes)", () => {
    const quoted = [
      '"Name","Email","Role","Status","Seat Tier"',
      '"Gareth Jones","gareth.jones@intenthq.com","Primary Owner","Active","Premium"',
      '"Jonathan Lakin","jonathan.lakin@intenthq.com","Owner","Active","Premium"',
    ].join("\n");
    const { seats, errors } = parseClaudeRoster(quoted);
    expect(errors).toEqual([]);
    expect(seats).toHaveLength(2);
    expect(seats[0]).toMatchObject({ email: "gareth.jones@intenthq.com", fullName: "Gareth Jones", role: "Primary Owner", seatType: "premium" });
  });

  it("keeps commas inside a quoted field (e.g. 'Last, First')", () => {
    const quoted = '"Name","Email","Role","Status","Seat Tier"\n"Doe, Jane","jane@x.com","User","Active","Standard"';
    const { seats } = parseClaudeRoster(quoted);
    expect(seats[0]).toMatchObject({ fullName: "Doe, Jane", email: "jane@x.com", seatType: "standard" });
  });
});
