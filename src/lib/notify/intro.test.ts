import { describe, expect, it } from "vitest";
import { BANNER_ALT, cadencePhrase, firstName, introFor } from "./intro";

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
    expect(cadencePhrase(["weekly", "monthly"], "personal")).toBe("weekly and monthly");
    expect(cadencePhrase(["monthly", "daily", "weekly"], "personal")).toBe("daily, weekly and monthly");
    expect(cadencePhrase(["daily"], "personal")).toBe("daily");
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
          "👋 *Hi Priya,* this is your first AI spend summary.\n\n" +
          "From now on you'll get weekly and monthly recaps. Each one shows what you spent on each AI tool, and the total for the people who report to you, compared with the period before.\n\n" +
          "_To start with, only department heads and the people with the highest AI spend get these._",
      },
    });
    expect(i.blocks[1]).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Use *Open in dashboard* for the detail. Questions? Ask <https://slack.com/app_redirect?channel=C02ND4XRSLR|Workplace Tech>." }],
    });
    expect(i.blocks.at(-1)).toEqual({ type: "divider" });
    expect(i.text).toBe("Hi Priya — your first AI spend summary. ");
  });

  it("speaks of teams to someone who manages managers", () => {
    expect(text(introFor({ ...base, cadences: ["weekly"], reports: "byTeam" }))).toContain(
      "Each one shows what you spent on each AI tool, and the total for the teams who report to you, compared with the period before.",
    );
  });

  it("leaves out reports for someone without any, and the dashboard for someone who can't open it", () => {
    const i = text(introFor({ ...base, cadences: ["weekly"], reports: "none", links: false }));
    expect(i).toContain("Each one shows what you spent on each AI tool, compared with the period before.\\n\\n_To start with");
    expect(i).not.toContain("Open in dashboard");
    expect(i).toContain('"text":"Questions? Ask <https://slack.com/app_redirect?channel=C02ND4XRSLR|Workplace Tech>."');
  });

  it("tells the personal list who gets these to start with, but not the company list", () => {
    const line = "_To start with, only department heads and the people with the highest AI spend get these._";
    expect(text(introFor({ ...base, cadences: ["weekly"], reports: "none", links: false }))).toContain(line);
    expect(text(introFor({ ...base, report: "company", cadences: ["weekly"] }))).not.toContain(line);
  });

  it("introduces the company report on its own terms", () => {
    const i = introFor({ ...base, report: "company", cadences: ["weekly", "monthly"] });
    expect(text(i)).toContain(
      "👋 *Hi Priya,* this is your first company AI spend report.\\n\\nYou'll get the whole company's AI spend each Monday and early each month: usage by team and person, then seats and subscriptions, compared with the period before.",
    );
    expect(i.text).toBe("Hi Priya — your first company AI spend report. ");
  });

  it("describes the welcome banner plainly for anyone who can't see it", () => {
    expect(BANNER_ALT).toBe("Welcome banner: a rising bar chart beside the words \"Your AI spend, in Slack\"");
  });

  it("opens with the welcome banner when one was uploaded", () => {
    const i = introFor({ ...base, cadences: ["weekly"], bannerFileId: "F9" });
    expect(i.blocks[0]).toEqual({ type: "image", slack_file: { id: "F9" }, alt_text: BANNER_ALT });
    expect(i.blocks[1]).toMatchObject({ type: "section" });
  });

  it("says hi there without a name, and escapes one that needs it", () => {
    expect(introFor({ ...base, cadences: ["weekly"], name: null }).text).toBe("Hi there — your first AI spend summary. ");
    expect(text(introFor({ ...base, cadences: ["weekly"], name: "Tom<&>" }))).toContain("*Hi Tom&lt;&amp;&gt;,*");
  });
});
