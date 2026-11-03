import { describe, expect, it } from "vitest";
import { parseSeatRoster } from "./seat-roster";

const csv = [
  "Name,Email,Role,Status,Seat Tier",
  "Gareth Jones,gareth.jones@intenthq.com,Primary Owner,Active,Premium",
  "Tom Reeve,tom.reeve@intenthq.com,User,Active,Standard",
  "Javier Pedreira,javier.pedreira@intenthq.com,User,Active,Unassigned",
].join("\n");

describe("parseSeatRoster", () => {
  it("parses roster rows into seats with normalized tiers", () => {
    const { seats, errors } = parseSeatRoster(csv);
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
    const { seats, errors } = parseSeatRoster(bad);
    expect(seats).toHaveLength(0);
    expect(errors[0].message).toMatch(/invalid email/);
  });

  it("rejects a file missing required columns", () => {
    const { errors } = parseSeatRoster("foo,bar\n1,2");
    expect(errors[0].message).toMatch(/missing required columns/);
  });

  it("parses the real QUOTED export (every field wrapped in double quotes)", () => {
    const quoted = [
      '"Name","Email","Role","Status","Seat Tier"',
      '"Gareth Jones","gareth.jones@intenthq.com","Primary Owner","Active","Premium"',
      '"Jonathan Lakin","jonathan.lakin@intenthq.com","Owner","Active","Premium"',
    ].join("\n");
    const { seats, errors } = parseSeatRoster(quoted);
    expect(errors).toEqual([]);
    expect(seats).toHaveLength(2);
    expect(seats[0]).toMatchObject({ email: "gareth.jones@intenthq.com", fullName: "Gareth Jones", role: "Primary Owner", seatType: "premium" });
  });

  it("keeps commas inside a quoted field (e.g. 'Last, First')", () => {
    const quoted = '"Name","Email","Role","Status","Seat Tier"\n"Doe, Jane","jane@x.com","User","Active","Standard"';
    const { seats } = parseSeatRoster(quoted);
    expect(seats[0]).toMatchObject({ fullName: "Doe, Jane", email: "jane@x.com", seatType: "standard" });
  });

  it("parses the ChatGPT Business members export (same columns, Membership Admin role)", () => {
    const chatgpt = [
      '"Name","Email","Role","Status","Seat Tier"',
      '"Pat Example","pat@example.com","Membership Admin","Active","Premium"',
      '"Sam Example","sam@example.com","User","Active","Standard"',
    ].join("\n");
    const { seats, errors } = parseSeatRoster(chatgpt);
    expect(errors).toEqual([]);
    expect(seats.map((s) => [s.email, s.role, s.seatType])).toEqual([
      ["pat@example.com", "Membership Admin", "premium"],
      ["sam@example.com", "User", "standard"],
    ]);
  });

  const cursorCsv = [
    "Name,Email,Role,Seat Type,Included Usage,Free Usage,On-Demand Usage",
    "Ada Example,ada.example@intenthq.com,Member,Standard,$12.00,$0.00,$184.20",
    "Bo Sample,bo.sample@intenthq.com,Team Admin,Premium,$40.00,$0.00,$0.00",
    "Cy Gone,cy.gone@intenthq.com,Removed,Standard,$0.00,$0.00,$0.00",
    "Di Trial,di.trial@intenthq.com,Member,Free,$0.00,$3.10,$0.00",
  ].join("\n");

  it("parses Cursor's members export: Seat Type column, Removed rows skipped, Free kept", () => {
    const { seats, errors } = parseSeatRoster(cursorCsv);
    expect(errors).toEqual([]);
    expect(seats.map((s) => [s.email, s.seatType, s.role])).toEqual([
      ["ada.example@intenthq.com", "standard", "Member"],
      ["bo.sample@intenthq.com", "premium", "Team Admin"],
      ["di.trial@intenthq.com", "free", "Member"],
    ]);
  });

  it("still requires a tier column under either name", () => {
    expect(parseSeatRoster("Name,Email,Role\nA,a@intenthq.com,Member").errors[0].message).toMatch(/Seat Tier/);
  });
});
