import { describe, expect, it } from "vitest";
import { defaultPreviewKey, dueDigests, latestCompleteKey, monthlyLastDay, periodFor, previousWorkingDay, resolveRunDate, sendDay, stepKey } from "./schedule";

const at = (iso: string) => new Date(`${iso}T07:00:00Z`);
const due = (day: string, ready: boolean) => dueDigests(day, ready).map((d) => `${d.period.cadence}:${d.period.key}${d.force ? ":force" : ""}`);

describe("periodFor", () => {
  const now = at("2026-09-30");
  it("daily: the day, the day before, and a 14-day chart", () => {
    const p = periodFor("daily", "2026-09-29", now);
    expect(p).toMatchObject({ label: "29 Sep 2026", from: "2026-09-29", toExclusive: "2026-09-30", prev: { from: "2026-09-28", toExclusive: "2026-09-29" }, compareTo: "previous day" });
    expect(p.buckets).toHaveLength(14);
    expect(p.buckets[0]).toMatchObject({ label: "16 Sep", from: "2026-09-16", current: false });
    expect(p.buckets[1].label).toBe("17");
    expect(p.buckets[13]).toMatchObject({ label: "29", from: "2026-09-29", current: true });
  });
  it("daily: a Monday compares with the Friday before, not the weekend", () => {
    expect(periodFor("daily", "2026-09-28", now)).toMatchObject({ prev: { from: "2026-09-25", toExclusive: "2026-09-26" }, compareTo: "Friday" });
  });
  it("weekly: ISO week, previous week, 8 Monday-labelled buckets", () => {
    const p = periodFor("weekly", "2026-W39", now);
    expect(p).toMatchObject({ label: "21–27 Sep 2026", from: "2026-09-21", toExclusive: "2026-09-28", prev: { from: "2026-09-14" }, compareTo: "previous week" });
    expect(p.buckets.map((b) => b.label)).toEqual(["3 Aug", "10", "17", "24", "31", "7 Sep", "14", "21"]);
  });
  it("monthly: calendar month, previous month, 6 month buckets", () => {
    const p = periodFor("monthly", "2026-09", now);
    expect(p).toMatchObject({ label: "September 2026", from: "2026-09-01", toExclusive: "2026-10-01", prev: { from: "2026-08-01", toExclusive: "2026-09-01" }, compareTo: "previous month" });
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

describe("working days", () => {
  it("steps back over weekends", () => {
    expect(["2026-10-06", "2026-10-05", "2026-10-04", "2026-10-03"].map(previousWorkingDay)).toEqual(["2026-10-05", "2026-10-02", "2026-10-02", "2026-10-02"]);
  });
  it("moves the monthly window's last day off a weekend to the Monday", () => {
    expect([monthlyLastDay("2026-10"), monthlyLastDay("2026-11"), monthlyLastDay("2026-12"), monthlyLastDay("2026-09")]).toEqual([5, 5, 7, 7]);
  });
});

describe("defaultPreviewKey", () => {
  it("previews the daily that would actually go out: a Monday or weekend shows Friday", () => {
    expect(defaultPreviewKey("daily", at("2026-09-28"))).toBe("2026-09-25");
    expect(defaultPreviewKey("daily", at("2026-10-04"))).toBe("2026-10-02");
    expect(defaultPreviewKey("daily", at("2026-09-30"))).toBe("2026-09-29");
    expect(defaultPreviewKey("weekly", at("2026-09-30"))).toBe("2026-W39");
  });
});

describe("dueDigests", () => {
  it("nothing at all on Saturday or Sunday", () => {
    expect(due("2026-10-03", true)).toEqual([]);
    expect(due("2026-10-04", true)).toEqual([]);
  });
  it("Tue–Fri: the day before; Monday: Friday's daily plus the weekly recap", () => {
    expect(due("2026-09-30", true)).toEqual(["daily:2026-09-29"]);
    expect(due("2026-09-28", true)).toEqual(["daily:2026-09-25", "weekly:2026-W39"]);
  });
  it("monthly from the 3rd once ready, forced on the window's last working day", () => {
    expect(due("2026-10-02", true)).toEqual(["daily:2026-10-01"]); // before the window
    expect(due("2026-11-03", true)).toEqual(["daily:2026-11-02", "monthly:2026-10"]);
    expect(due("2026-11-03", false)).toEqual(["daily:2026-11-02"]);
    expect(due("2026-10-05", false)).toEqual(["daily:2026-10-02", "weekly:2026-W40", "monthly:2026-09:force"]); // 3rd/4th were the weekend
    expect(due("2026-10-06", true)).toEqual(["daily:2026-10-05"]);
    expect(due("2026-12-04", false)).toEqual(["daily:2026-12-03"]);
    expect(due("2026-12-07", false)).toEqual(["daily:2026-12-04", "weekly:2026-W49", "monthly:2026-11:force"]); // the 5th was a Saturday
  });
});

describe("sendDay", () => {
  it("is the recipient's local day once it's 10:30 there, across the October clock change", () => {
    expect(sendDay(new Date("2026-10-07T09:29:00Z"), "Europe/London")).toBeNull(); // 10:29 BST
    expect(sendDay(new Date("2026-10-07T09:30:00Z"), "Europe/London")).toBe("2026-10-07");
    expect(sendDay(new Date("2026-10-26T10:29:00Z"), "Europe/London")).toBeNull(); // 10:29 GMT
    expect(sendDay(new Date("2026-10-26T10:30:00Z"), "Europe/London")).toBe("2026-10-26");
  });
  it("follows the recipient's own zone, including one whose day is ahead of UTC", () => {
    expect(sendDay(new Date("2026-10-07T13:29:00Z"), "America/Sao_Paulo")).toBeNull();
    expect(sendDay(new Date("2026-10-07T13:30:00Z"), "America/Sao_Paulo")).toBe("2026-10-07");
    expect(sendDay(new Date("2026-10-06T23:30:00Z"), "Australia/Sydney")).toBe("2026-10-07"); // 10:30 AEDT Wed
  });
  it("never on a local weekend", () => {
    expect(sendDay(new Date("2026-10-10T12:00:00Z"), "Europe/London")).toBeNull();
  });
  it("falls back to London for an unknown or invalid zone", () => {
    expect(sendDay(new Date("2026-10-07T09:30:00Z"), null)).toBe("2026-10-07");
    expect(sendDay(new Date("2026-10-07T09:29:00Z"), "Mars/Olympus_Mons")).toBeNull();
  });
});

describe("resolveRunDate", () => {
  const real = new Date("2026-09-30T07:02:00Z");
  it("uses real time without a param", () => {
    expect(resolveRunDate(null, "live", real)).toEqual({ now: real, replay: false });
  });
  it("refuses replays outside preview mode (would DM real people about old periods)", () => {
    expect(resolveRunDate("2026-09-28", "live", real)).toHaveProperty("error");
  });
  it("replays a valid day in preview (flagged, so the 10:30 gate is skipped), rejects impossible dates", () => {
    expect(resolveRunDate("2026-09-28", "preview", real)).toEqual({ now: new Date("2026-09-28T07:00:00Z"), replay: true });
    expect(resolveRunDate("2026-02-30", "preview", real)).toHaveProperty("error");
    expect(resolveRunDate("yesterday", "preview", real)).toHaveProperty("error");
  });
});
