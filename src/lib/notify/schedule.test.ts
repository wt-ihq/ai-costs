import { describe, expect, it } from "vitest";
import { dueDigests, latestCompleteKey, periodFor, resolveRunDate, stepKey } from "./schedule";

const at = (iso: string) => new Date(`${iso}T07:00:00Z`);
const due = (iso: string, ready: boolean) => dueDigests(at(iso), ready).map((d) => `${d.period.cadence}:${d.period.key}${d.force ? ":force" : ""}`);

describe("periodFor", () => {
  const now = at("2026-09-30");
  it("daily: the day, the day before, and a 14-day chart", () => {
    const p = periodFor("daily", "2026-09-29", now);
    expect(p).toMatchObject({ label: "29 Sep 2026", from: "2026-09-29", toExclusive: "2026-09-30", prev: { from: "2026-09-28", toExclusive: "2026-09-29" } });
    expect(p.buckets).toHaveLength(14);
    expect(p.buckets[0]).toMatchObject({ label: "16 Sep", from: "2026-09-16", current: false });
    expect(p.buckets[1].label).toBe("17");
    expect(p.buckets[13]).toMatchObject({ label: "29", from: "2026-09-29", current: true });
  });
  it("weekly: ISO week, previous week, 8 Monday-labelled buckets", () => {
    const p = periodFor("weekly", "2026-W39", now);
    expect(p).toMatchObject({ label: "21–27 Sep 2026", from: "2026-09-21", toExclusive: "2026-09-28", prev: { from: "2026-09-14" } });
    expect(p.buckets.map((b) => b.label)).toEqual(["3 Aug", "10", "17", "24", "31", "7 Sep", "14", "21"]);
  });
  it("monthly: calendar month, previous month, 6 month buckets", () => {
    const p = periodFor("monthly", "2026-09", now);
    expect(p).toMatchObject({ label: "September 2026", from: "2026-09-01", toExclusive: "2026-10-01", prev: { from: "2026-08-01", toExclusive: "2026-09-01" } });
    expect(p.buckets.map((b) => b.label)).toEqual(["Apr", "May", "Jun", "Jul", "Aug", "Sep"]);
  });
  it("rejects a key of the wrong cadence or a malformed key (parsePeriod silently falls back)", () => {
    expect(() => periodFor("weekly", "2026-09", now)).toThrow();
    expect(() => periodFor("monthly", "2026-09x", now)).toThrow();
    expect(() => periodFor("daily", "2026-02-30", now)).toThrow();
  });
});

describe("latestCompleteKey / stepKey", () => {
  it("handles the ISO 53-week year boundary", () => {
    expect(latestCompleteKey("weekly", at("2027-01-04"))).toBe("2026-W53");
    expect(latestCompleteKey("daily", at("2026-10-01"))).toBe("2026-09-30");
    expect(latestCompleteKey("monthly", at("2026-10-03"))).toBe("2026-09");
  });
  it("never steps past the latest complete period", () => {
    const now = at("2026-09-30");
    expect(stepKey("daily", "2026-09-29", 1, now)).toBeNull();
    expect(stepKey("daily", "2026-09-29", -1, now)).toBe("2026-09-28");
    expect(stepKey("weekly", "2026-W38", 1, now)).toBe("2026-W39");
  });
});

describe("dueDigests", () => {
  it("daily always; weekly on Mondays", () => {
    expect(due("2026-09-30", true)).toEqual(["daily:2026-09-29"]);
    expect(due("2026-09-28", true)).toEqual(["daily:2026-09-27", "weekly:2026-W39"]);
  });
  it("monthly only in the 3rd–5th window: when ready, or forced on the 5th", () => {
    expect(due("2026-10-01", true)).toEqual(["daily:2026-09-30"]);
    expect(due("2026-10-02", true)).toEqual(["daily:2026-10-01"]);
    expect(due("2026-10-03", true)).toEqual(["daily:2026-10-02", "monthly:2026-09"]);
    expect(due("2026-10-03", false)).toEqual(["daily:2026-10-02"]);
    expect(due("2026-10-05", false)).toEqual(["daily:2026-10-04", "weekly:2026-W40", "monthly:2026-09:force"]);
    expect(due("2026-10-06", true)).toEqual(["daily:2026-10-05"]);
  });
});

describe("resolveRunDate", () => {
  const real = new Date("2026-09-30T07:02:00Z");
  it("uses real time without a param", () => {
    expect(resolveRunDate(null, "live", real)).toEqual({ now: real });
  });
  it("refuses replays outside preview mode (would DM real people about old periods)", () => {
    expect(resolveRunDate("2026-09-28", "live", real)).toHaveProperty("error");
  });
  it("replays a valid day at 07:00 UTC in preview, rejects impossible dates", () => {
    expect(resolveRunDate("2026-09-28", "preview", real)).toEqual({ now: new Date("2026-09-28T07:00:00Z") });
    expect(resolveRunDate("2026-02-30", "preview", real)).toHaveProperty("error");
    expect(resolveRunDate("yesterday", "preview", real)).toHaveProperty("error");
  });
});
