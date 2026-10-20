import { VENDOR_LABEL } from "@/lib/types";
import type { Outstanding } from "./readiness";
import type { RenderedDigest, SlackBlock } from "./render";

/** The update reminders (spec §4). Pure: blocks + notification text. */
export interface WeeklyReminderInput {
  week: { label: string; lastDay: string }; // "12–18 Oct 2026", its Sunday
  outstanding: Outstanding[];
  /** Last month's recap is due but waiting: its missing imports' labels. */
  monthly: { monthName: string; missing: string[] } | null;
  waiting: number; // weekly recipients not sent yet
  importsUrl: string;
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const d = (day: string) => `${Number(day.slice(8, 10))} ${SHORT[Number(day.slice(5, 7)) - 1]}`;
const header = (text: string): SlackBlock => ({ type: "header", text: { type: "plain_text", text, emoji: true } });
const section = (text: string): SlackBlock => ({ type: "section", text: { type: "mrkdwn", text } });
const button = (url: string): SlackBlock => ({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open Data → Imports" }, url }] });

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function line(o: Outstanding, lastDay: string): string {
  if (o.kind === "claudeSpend") {
    // A week ending on the month's last day: Claude's table has reset by Monday, so it's dated today.
    const dated = nextDay(lastDay).slice(0, 7) === lastDay.slice(0, 7) ? d(lastDay) : "today";
    return `⬜ *Claude Team spend* — pasted as of ${d(o.asOf)}. Paste this morning's table (dated ${dated}).`;
  }
  if (o.kind === "chatgptCredits") return `⬜ *ChatGPT credits* — imported through ${d(o.through)}. Import a file through ${d(lastDay)}.`;
  return `⬜ *${VENDOR_LABEL[o.source]}* hasn't synced since the week ended${o.lastSuccessDay ? ` (last ${d(o.lastSuccessDay)})` : ""}. Re-run it on Data → Sync.`;
}

export function weeklyReminder(i: WeeklyReminderInput): RenderedDigest {
  const lines = i.outstanding.length
    ? i.outstanding.map((o) => line(o, i.week.lastDay))
    : [`✅ Everything's in for ${i.week.label}. Weekly summaries go out from 10:30.`];
  if (i.monthly) lines.push(`${i.monthly.monthName}'s monthly recap is waiting too: ${i.monthly.missing.map((m) => `⬜ ${m}`).join(" · ")}`);
  const blocks: SlackBlock[] = [header(`🗓 Weekly updates · ${i.week.label}`), section(lines.join("\n"))];
  if (i.outstanding.length && i.waiting > 0) {
    const n = i.waiting === 1 ? "1 weekly summary goes" : `${i.waiting} weekly summaries go`;
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${n} out automatically once everything's in.` }] });
  }
  blocks.push(button(i.importsUrl));
  return { blocks, text: `Weekly updates for ${i.week.label}: ${i.outstanding.length ? `${i.outstanding.length} to do` : "all done"}` };
}

export function monthEndReminder(i: { monthName: string; importsUrl: string }): RenderedDigest {
  return {
    blocks: [
      header("🗓 Paste Claude Team spend today"),
      section(`Claude's table resets when the month ends. Pasting it today (dated today) captures ${i.monthName}'s last days for the monthly recap and the weekly summaries.`),
      button(i.importsUrl),
    ],
    text: "Paste Claude Team spend today",
  };
}
