import { describe, expect, it } from "vitest";
import { defaultPasteDate, spreadClaudeSnapshots, type ClaudeSnapshotRow } from "./claude-spread";

const snap = (asOf: string, email: string, mtdUsd: number, employeeId: string | null = `e-${email}`): ClaudeSnapshotRow => ({ asOf, email, employeeId, mtdUsd });
const byDay = (facts: ReturnType<typeof spreadClaudeSnapshots>, email: string) =>
  Object.fromEntries(facts.filter((f) => f.entityKey === email).map((f) => [f.day, f.costUsd]));
const total = (facts: ReturnType<typeof spreadClaudeSnapshots>, email: string) =>
  Math.round(facts.filter((f) => f.entityKey === email).reduce((s, f) => s + f.costUsd, 0) * 100) / 100;

describe("spreadClaudeSnapshots", () => {
  it("spreads a month's first paste from the 1st to its date", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-04", "p@x", 40)], "2026-10");
    expect(byDay(f, "p@x")).toEqual({ "2026-10-01": 10, "2026-10-02": 10, "2026-10-03": 10, "2026-10-04": 10 });
    expect(f[0]).toMatchObject({ source: "claude_team", costType: "overage", entityKey: "p@x", employeeId: "e-p@x" });
  });

  it("spreads each later paste's increase over the days since the previous paste", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-04", "p@x", 40), snap("2026-10-11", "p@x", 110)], "2026-10");
    expect(byDay(f, "p@x")["2026-10-05"]).toBe(10);
    expect(byDay(f, "p@x")["2026-10-11"]).toBe(10);
    expect(total(f, "p@x")).toBe(110);
  });

  it("keeps a person's last value when they're missing from a later paste", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-04", "p@x", 40), snap("2026-10-04", "q@x", 8), snap("2026-10-11", "p@x", 110)], "2026-10");
    expect(total(f, "q@x")).toBe(8);
    expect(Object.keys(byDay(f, "q@x"))).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  });

  it("spreads a decrease too, so the month still equals the latest paste", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-04", "p@x", 40), snap("2026-10-11", "p@x", 33)], "2026-10");
    expect(byDay(f, "p@x")["2026-10-05"]).toBe(-1);
    expect(total(f, "p@x")).toBe(33);
  });

  it("is exact to the cent: the remainder lands on the paste's own day", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-03", "p@x", 10)], "2026-10");
    expect(byDay(f, "p@x")).toEqual({ "2026-10-01": 3.33, "2026-10-02": 3.33, "2026-10-03": 3.34 });
  });

  it("only uses pastes dated in the month", () => {
    const f = spreadClaudeSnapshots([snap("2026-09-30", "p@x", 500), snap("2026-10-02", "p@x", 20)], "2026-10");
    expect(byDay(f, "p@x")).toEqual({ "2026-10-01": 10, "2026-10-02": 10 });
  });

  it("out-of-order pastes give the same facts", () => {
    const rows = [snap("2026-10-11", "p@x", 110), snap("2026-10-04", "p@x", 40)];
    expect(spreadClaudeSnapshots(rows, "2026-10")).toEqual(spreadClaudeSnapshots([...rows].reverse(), "2026-10"));
  });

  it("uses the latest paste's employee for every day", () => {
    const f = spreadClaudeSnapshots([snap("2026-10-04", "p@x", 40, null), snap("2026-10-11", "p@x", 110, "e-1")], "2026-10");
    expect(new Set(f.map((x) => x.employeeId))).toEqual(new Set(["e-1"]));
  });
});

describe("defaultPasteDate", () => {
  it("is Sunday on a Monday (the table includes Monday morning), today otherwise", () => {
    expect(defaultPasteDate("2026-10-19")).toBe("2026-10-18");
    expect(defaultPasteDate("2026-10-20")).toBe("2026-10-20");
    expect(defaultPasteDate("2026-10-30")).toBe("2026-10-30");
  });
});
