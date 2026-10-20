import type { SlackBlock } from "./render";
import { CADENCES, type Cadence, type ReportKind } from "./types";

/**
 * The few lines at the top of a person's first live message (run-notify.ts decides who): hello by
 * first name, what these messages are and when they come, and who to ask. Adapts to the person: the
 * list it's for, their cadences, whether they have reports (and teams of reports), and whether they
 * can open the dashboard. Pure; the renderer puts it above the digest (render.ts:RenderOpts.intro).
 */
export interface IntroInput {
  name: string | null; // first name; null → "Hi there"
  report: ReportKind;
  cadences: Cadence[]; // the person's cadences on that list
  /** personal: none · direct (a reports section) · byTeam (managers of managers: split by team). */
  reports: "none" | "direct" | "byTeam";
  links: boolean; // can open the dashboard
  /** The uploaded welcome banner (chart-image.ts:renderWelcomeBannerPng); absent = the text alone. */
  bannerFileId?: string;
}

export const BANNER_ALT = "Your AI spend, in Slack: what your AI tools cost, and how it's changing";

/** The first word of an Okta name ("Jerry Marcel Lieveld" → "Jerry"); null when there's none. */
export function firstName(fullName: string): string | null {
  return fullName.trim().split(/\s+/)[0] || null;
}

const PERSONAL: Record<Cadence, string> = {
  daily: "a daily summary each working day",
  weekly: "a weekly summary each Monday",
  monthly: "a monthly recap early each month",
};
const COMPANY: Record<Cadence, string> = { daily: "each working day", weekly: "each Monday", monthly: "early each month" };

const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** When the messages come, in cadence order: "a weekly summary each Monday and a monthly recap early each month". */
export function cadencePhrase(cadences: Cadence[], report: ReportKind): string {
  const words = report === "company" ? COMPANY : PERSONAL;
  return andList(CADENCES.filter((c) => cadences.includes(c)).map((c) => words[c]));
}

// Slack mrkdwn control characters (render.ts:escapeMrkdwn, inlined to keep this module free of the renderer).
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const REPORTS_LINE: Record<Exclude<IntroInput["reports"], "none">, string> = {
  direct: "• *Your reports:* the total for the people who report to you, and who uses the most.",
  byTeam: "• *Your reports:* everyone below you, split by team (each of your direct reports and their people), and who uses the most.",
};

export function introFor(i: IntroInput): { blocks: SlackBlock[]; text: string } {
  const hi = i.name ? esc(i.name) : "there";
  const what = i.report === "company" ? "company AI spend report" : "AI spend summary";
  const body =
    i.report === "company"
      ? [
          `👋 *Hi ${hi},* this is your first ${what}.`,
          `You'll get the whole company's AI spend ${cadencePhrase(i.cadences, "company")}: usage by team and person, then seats and subscriptions, compared with the period before.`,
        ]
      : [
          `👋 *Hi ${hi},* this is your first ${what}.`,
          `You'll get ${cadencePhrase(i.cadences, "personal")}, showing what your use of AI tools costs and how it compares with the period before:`,
          "• *You:* your own usage, by tool.",
          ...(i.reports === "none" ? [] : [REPORTS_LINE[i.reports]]),
        ];
  const footer =
    `Figures come from each tool's own billing data, updated overnight.${i.links ? " Use *Open in dashboard* for the detail." : ""}\n` +
    "Questions, or want these more or less often? Ask Workplace Tech.";
  return {
    blocks: [
      ...(i.bannerFileId ? [{ type: "image", slack_file: { id: i.bannerFileId }, alt_text: BANNER_ALT }] : []),
      { type: "section", text: { type: "mrkdwn", text: body.join("\n") } },
      { type: "context", elements: [{ type: "mrkdwn", text: footer }] },
      { type: "divider" },
    ],
    text: `Hi ${hi} — your first ${what}. `,
  };
}
