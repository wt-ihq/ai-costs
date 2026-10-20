import { describe, expect, it } from "vitest";
import { cadencePhrase, firstName, introFor } from "./intro";

describe("firstName", () => {
  it("is the first word of the Okta name", () => {
    expect(firstName("Jerry Marcel Lieveld")).toBe("Jerry");
    expect(firstName("  Priya   Nair ")).toBe("Priya");
  });
  it("is null when there's no usable name", () => {
    expect(firstName("")).toBeNull();
    expect(firstName("   ")).toBeNull();
  });
});

describe("cadencePhrase", () => {
  it("names each cadence the person is on, in order", () => {
    expect(cadencePhrase(["weekly", "monthly"], "personal")).toBe("a weekly summary each Monday and a monthly recap early each month");
    expect(cadencePhrase(["monthly", "daily", "weekly"], "personal")).toBe(
      "a daily summary each working day, a weekly summary each Monday and a monthly recap early each month",
    );
    expect(cadencePhrase(["daily"], "personal")).toBe("a daily summary each working day");
  });
  it("speaks of when, for the company report", () => {
    expect(cadencePhrase(["weekly", "monthly"], "company")).toBe("each Monday and early each month");
    expect(cadencePhrase(["daily"], "company")).toBe("each working day");
  });
});

describe("introFor", () => {
  const base = { name: "Priya", report: "personal" as const, cadences: ["weekly", "monthly"] as const, reports: "direct" as const, links: true };
  const text = (i: ReturnType<typeof introFor>) => JSON.stringify(i.blocks);

  it("greets by first name, says what's coming and when, and who to ask", () => {
    const i = introFor({ ...base, cadences: [...base.cadences] });
    expect(i.blocks[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "👋 *Hi Priya,* this is your first AI spend summary.\n" +
          "You'll get a weekly summary each Monday and a monthly recap early each month, showing what your use of AI tools costs and how it compares with the period before:\n" +
          "• *You:* your own usage, by tool.\n" +
          "• *Your reports:* the total for the people who report to you, and who uses the most.",
      },
    });
    expect(i.blocks[1]).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Figures come from each tool's own billing data, updated overnight. Use *Open in dashboard* for the detail.\nQuestions, or want these more or less often? Ask Workplace Tech." }],
    });
    expect(i.blocks.at(-1)).toEqual({ type: "divider" });
    expect(i.text).toBe("Hi Priya — your first AI spend summary. ");
  });

  it("speaks of teams to someone who manages managers", () => {
    expect(text(introFor({ ...base, cadences: ["weekly"], reports: "byTeam" }))).toContain(
      "• *Your reports:* everyone below you, split by team (each of your direct reports and their people), and who uses the most.",
    );
  });

  it("leaves out reports for someone without any, and the dashboard for someone who can't open it", () => {
    const i = text(introFor({ ...base, cadences: ["weekly"], reports: "none", links: false }));
    expect(i).not.toContain("Your reports");
    expect(i).not.toContain("Open in dashboard");
    expect(i).toContain("Figures come from each tool's own billing data, updated overnight.\\nQuestions");
  });

  it("introduces the company report on its own terms", () => {
    const i = introFor({ ...base, report: "company", cadences: ["weekly", "monthly"] });
    expect(text(i)).toContain(
      "👋 *Hi Priya,* this is your first company AI spend report.\\nYou'll get the whole company's AI spend each Monday and early each month: usage by team and person, then seats and subscriptions, compared with the period before.",
    );
    expect(i.text).toBe("Hi Priya — your first company AI spend report. ");
  });

  it("says hi there without a name, and escapes one that needs it", () => {
    expect(introFor({ ...base, cadences: ["weekly"], name: null }).text).toBe("Hi there — your first AI spend summary. ");
    expect(text(introFor({ ...base, cadences: ["weekly"], name: "Tom<&>" }))).toContain("*Hi Tom&lt;&amp;&gt;,*");
  });
});
