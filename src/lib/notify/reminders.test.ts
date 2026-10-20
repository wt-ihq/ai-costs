import { describe, expect, it } from "vitest";
import { monthEndReminder, weeklyReminder } from "./reminders";

const base = { week: { label: "12–18 Oct 2026", lastDay: "2026-10-18" }, monthly: null, waiting: 24, importsUrl: "https://x.test/data?tab=imports" };
const text = (r: { blocks: unknown[] }) => JSON.stringify(r.blocks);

describe("weeklyReminder", () => {
  it("lists what's outstanding, how many summaries wait, and links to Imports", () => {
    const r = weeklyReminder({
      ...base,
      outstanding: [
        { kind: "claudeSpend", asOf: "2026-10-11" },
        { kind: "chatgptCredits", through: "2026-10-11" },
        { kind: "sync", source: "openai", lastSuccessDay: "2026-10-17" },
      ],
    });
    expect(r.blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "🗓 Weekly updates · 12–18 Oct 2026", emoji: true } });
    expect(text(r)).toContain("⬜ *Claude Team spend* — pasted as of 11 Oct. Paste this morning's table (dated 18 Oct).");
    expect(text(r)).toContain("⬜ *ChatGPT credits* — imported through 11 Oct. Import a file through 18 Oct.");
    expect(text(r)).toContain("⬜ *OpenAI API* hasn't synced since the week ended (last 17 Oct). Re-run it on Data → Sync.");
    expect(text(r)).toContain("24 weekly summaries go out automatically once everything's in.");
    expect(r.blocks.at(-1)).toEqual({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open Data → Imports" }, url: "https://x.test/data?tab=imports" }] });
    expect(r.text).toBe("Weekly updates for 12–18 Oct 2026: 3 to do");
  });

  it("says everything's in when nothing is outstanding", () => {
    const r = weeklyReminder({ ...base, outstanding: [] });
    expect(text(r)).toContain("✅ Everything's in for 12–18 Oct 2026. Weekly summaries go out from 10:30.");
    expect(text(r)).not.toContain("go out automatically once");
    expect(r.text).toBe("Weekly updates for 12–18 Oct 2026: all done");
  });

  it("adds last month's missing imports while its recap waits", () => {
    const r = weeklyReminder({ ...base, outstanding: [], monthly: { monthName: "October", missing: ["Claude Team seats"] } });
    expect(text(r)).toContain("October's monthly recap is waiting too: ⬜ Claude Team seats");
  });

  it("when the week ended on the month's last day, asks for today's table (it has reset)", () => {
    const r = weeklyReminder({ ...base, week: { label: "25–31 Jan 2027", lastDay: "2027-01-31" }, outstanding: [{ kind: "claudeSpend", asOf: "2027-01-29" }] });
    expect(text(r)).toContain("⬜ *Claude Team spend* — pasted as of 29 Jan. Paste this morning's table (dated today).");
  });

  it("one summary reads in the singular", () => {
    expect(text(weeklyReminder({ ...base, waiting: 1, outstanding: [{ kind: "claudeSpend", asOf: "2026-10-11" }] }))).toContain("1 weekly summary goes out automatically");
  });
});

describe("monthEndReminder", () => {
  it("asks for today's Claude Team paste before the table resets", () => {
    const r = monthEndReminder({ monthName: "October", importsUrl: "https://x.test/data?tab=imports" });
    expect(text(r)).toContain("Claude's table resets when the month ends. Pasting it today (dated today) captures October's last days for the monthly recap and the weekly summaries.");
    expect(r.text).toBe("Paste Claude Team spend today");
  });
});
