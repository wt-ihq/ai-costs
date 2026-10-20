import { describe, expect, it } from "vitest";
import { monthStatus, weekStatus } from "./week-status";

const base = { label: "12–18 Oct 2026", weekToExclusive: "2026-10-19", recipients: 24, sent: 0 };
describe("weekStatus", () => {
  it("waiting: names what's missing", () => {
    expect(weekStatus({ ...base, today: "2026-10-19", readiness: { ready: false, outstanding: [{ kind: "claudeSpend", asOf: "2026-10-11" }, { kind: "chatgptCredits", through: "2026-10-11" }] } }))
      .toEqual({ state: "waiting", title: "Weekly 12–18 Oct 2026", text: "Waiting for Claude Team (pasted as of 11 Oct) · ChatGPT credits (through 11 Oct)" });
  });
  it("ready, not sent yet", () => {
    expect(weekStatus({ ...base, today: "2026-10-19", readiness: { ready: true, outstanding: [] } }).text).toBe("Ready — going out from 10:30");
  });
  it("sent", () => {
    expect(weekStatus({ ...base, sent: 24, today: "2026-10-20", readiness: { ready: true, outstanding: [] } })).toMatchObject({ state: "sent", text: "Sent to 24 of 24" });
  });
  it("skipped once Friday has passed without it", () => {
    expect(weekStatus({ ...base, today: "2026-10-24", readiness: { ready: false, outstanding: [{ kind: "claudeSpend", asOf: "2026-10-11" }] } }))
      .toMatchObject({ state: "skipped", text: "Skipped — not ready by Friday" });
  });
});

describe("monthStatus", () => {
  const m = { label: "September 2026", recipients: 5, sent: 0, missing: [] as string[], today: "2026-10-05" };
  it("nothing to show without monthly recipients", () => {
    expect(monthStatus({ ...m, recipients: 0 })).toBeNull();
  });
  it("before the 3rd: due from the 3rd", () => {
    expect(monthStatus({ ...m, today: "2026-10-02" })).toEqual({ state: "waiting", title: "Monthly September 2026", text: "Due from the 3rd" });
  });
  it("waiting: names what's missing", () => {
    expect(monthStatus({ ...m, missing: ["Claude Team seats", "OpenAI API sync"] })).toMatchObject({ state: "waiting", text: "Waiting for Claude Team seats · OpenAI API sync" });
  });
  it("ready, then sent", () => {
    expect(monthStatus(m)).toMatchObject({ state: "ready", text: "Ready — going out from 10:30" });
    expect(monthStatus({ ...m, sent: 5 })).toMatchObject({ state: "sent", text: "Sent to 5 of 5" });
  });
});
