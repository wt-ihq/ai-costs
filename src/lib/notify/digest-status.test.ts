import { describe, expect, it } from "vitest";
import { digestStatusRows, nextAutomaticSendDay, type DigestStatusInput } from "./digest-status";
import { periodFor } from "./schedule";

const now = new Date("2026-10-26T09:00:00Z"); // Monday
const W43 = periodFor("weekly", "2026-W43", now); // 19–25 Oct
const W42 = periodFor("weekly", "2026-W42", now);
const SEP = periodFor("monthly", "2026-09", now);
const entry = (over: Partial<DigestStatusInput["periods"][number]> & { cadence: "weekly" | "monthly" }): DigestStatusInput["periods"][number] => ({
  period: over.cadence === "weekly" ? W43 : SEP,
  readiness: { ready: true, missing: [] },
  recipients: { personal: 40, company: 3 },
  sends: [],
  previous: false,
  ...over,
});
const sentRows = (n: number, at: string) => Array.from({ length: n }, () => ({ status: "sent", updatedAt: at }));

describe("nextAutomaticSendDay", () => {
  it("weekly: today on a working day, else the next working day", () => {
    expect(nextAutomaticSendDay("2026-10-26", "weekly")).toBe("2026-10-26"); // Monday
    expect(nextAutomaticSendDay("2026-10-31", "weekly")).toBe("2026-11-02"); // Saturday → Monday
  });
  it("monthly: never before the 3rd", () => {
    expect(nextAutomaticSendDay("2026-11-01", "monthly")).toBe("2026-11-03"); // Sunday 1st → Tuesday 3rd
    expect(nextAutomaticSendDay("2026-10-26", "monthly")).toBe("2026-10-26");
  });
});

describe("digestStatusRows", () => {
  it("a Monday with the week ready and the month waiting", () => {
    const rows = digestStatusRows({
      today: "2026-10-26", mode: "live", previewEmail: null,
      periods: [entry({ cadence: "weekly" }), entry({ cadence: "monthly", readiness: { ready: false, missing: ["ChatGPT Business credits"] } })],
    });
    expect(rows).toEqual([
      {
        cadence: "weekly", periodKey: "2026-W43", label: "Weekly 19–25 Oct 2026", state: "ready", statusText: "Ready",
        nextSend: "Next hourly run, from 10:30 in each person's own time zone, today (Mon 26 Oct)", sentText: null, recipients: 43,
        sendNow: { label: "Send now", confirm: "Send the weekly summary for 19–25 Oct 2026 now to 40 people (and the company report to 3)?" }, missing: [],
      },
      {
        cadence: "monthly", periodKey: "2026-09", label: "Monthly September 2026", state: "waiting", statusText: "Waiting for ChatGPT Business credits",
        nextSend: "Once it's in: the next hourly run, from 10:30 in each person's own time zone", sentText: null, recipients: 43,
        sendNow: null, missing: ["ChatGPT Business credits"],
      },
    ]);
  });

  it("a weekly not ready: Send anyway, naming what's missing", () => {
    const [row] = digestStatusRows({
      today: "2026-10-26", mode: "live", previewEmail: null,
      periods: [entry({ cadence: "weekly", readiness: { ready: false, missing: ["ChatGPT credits (through 11 Oct)", "Claude Team (pasted as of 19 Oct)"] } })],
    });
    expect(row).toMatchObject({
      state: "waiting", statusText: "Waiting for ChatGPT credits (through 11 Oct) · Claude Team (pasted as of 19 Oct)",
      sendNow: { label: "Send anyway", confirm: "Still missing: ChatGPT credits (through 11 Oct), Claude Team (pasted as of 19 Oct). Figures for those will be incomplete. Send anyway to 40 people (and the company report to 3)?" },
    });
  });

  it("skipped: a Saturday after the Friday with nothing sent", () => {
    const [row] = digestStatusRows({
      today: "2026-10-31", mode: "live", previewEmail: null,
      periods: [entry({ cadence: "weekly", readiness: { ready: false, missing: ["Claude Team (pasted as of 19 Oct)"] } })],
    });
    expect(row).toMatchObject({ state: "skipped", statusText: "Not ready by Friday, so it won't go out by itself. You can still send it now.", nextSend: null, sendNow: { label: "Send anyway" } });
  });

  it("sent: who and when, no next send, Send now still offered for retries", () => {
    const [row] = digestStatusRows({
      today: "2026-10-26", mode: "live", previewEmail: null,
      periods: [entry({ cadence: "weekly", period: W42, sends: [...sentRows(41, "2026-10-20T09:31:00Z"), { status: "failed", updatedAt: "2026-10-20T09:31:00Z" }] })],
    });
    expect(row).toMatchObject({ state: "sent", statusText: "Sent", sentText: "41 of 43 on Tue 20 Oct", nextSend: null, sendNow: { label: "Send now" } });
  });

  it("a previous period is shown only when it has sends", () => {
    const rows = digestStatusRows({
      today: "2026-10-26", mode: "live", previewEmail: null,
      periods: [
        entry({ cadence: "weekly" }),
        entry({ cadence: "weekly", period: W42, previous: true }),
        entry({ cadence: "monthly", period: periodFor("monthly", "2026-08", now), previous: true, sends: sentRows(5, "2026-09-03T09:31:00Z") }),
      ],
    });
    expect(rows.map((r) => r.periodKey)).toEqual(["2026-W43", "2026-08"]);
  });

  it("monthly before the 3rd: waiting for the 3rd, no Send now — the automatic sources aren't final yet", () => {
    const [row] = digestStatusRows({ today: "2026-11-01", mode: "live", previewEmail: null, periods: [entry({ cadence: "monthly", period: periodFor("monthly", "2026-10", now) })] });
    expect(row).toMatchObject({ state: "waiting", statusText: "Due from the 3rd", sendNow: null, nextSend: "Next hourly run, from 10:30 in each person's own time zone, Tue 3 Nov (from the 3rd)" });
    const [missing] = digestStatusRows({
      today: "2026-11-01", mode: "live", previewEmail: null,
      periods: [entry({ cadence: "monthly", period: periodFor("monthly", "2026-10", now), readiness: { ready: false, missing: ["Claude Team usage"] } })],
    });
    expect(missing).toMatchObject({ state: "waiting", statusText: "Waiting for Claude Team usage · Due from the 3rd", sendNow: null });
  });

  it("preview mode says so", () => {
    const [row] = digestStatusRows({ today: "2026-10-26", mode: "preview", previewEmail: "g@x.com", periods: [entry({ cadence: "weekly" })] });
    expect(row.nextSend).toBe("Next hourly run, from 10:30 in each person's own time zone, today (Mon 26 Oct) (preview: to the preview inbox)");
    expect(row.sendNow?.confirm).toBe("Send the weekly summary for 19–25 Oct 2026 now to the preview inbox (g@x.com) as 43 preview messages?");
  });

  it("a monthly before the first one says so, with no button and no next send", () => {
    const rows = digestStatusRows({
      today: "2026-10-26", mode: "live", previewEmail: null, monthlyFrom: "2026-10",
      periods: [entry({ cadence: "monthly" })],
    });
    expect(rows).toEqual([
      expect.objectContaining({
        cadence: "monthly", periodKey: "2026-09", state: "before_start",
        statusText: "Not sent: monthly summaries start with October 2026, in November.", nextSend: null, sendNow: null,
      }),
    ]);
    // Once the month is in range the row is as before.
    expect(digestStatusRows({ today: "2026-10-26", mode: "live", previewEmail: null, monthlyFrom: "2026-09", periods: [entry({ cadence: "monthly" })] })[0].state).toBe("ready");
  });
});
