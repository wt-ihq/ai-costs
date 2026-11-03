import type { RecommendationsData } from "@/lib/recommendations/load";
import type { RecRow, RecToolResult } from "@/lib/recommendations/rule";
import { VENDOR_LABEL } from "@/lib/types";
import { formatWholeUsd } from "@/lib/utils";
import { escapeMrkdwn, HEADER_EMOJI, type RenderedDigest, type SlackBlock } from "./render";

/** The weekly Premium seat recommendations DM. Pure: blocks + notification text. */
export const REC_LIST_MAX = 10;

export interface RecommendationsMessageInput {
  data: RecommendationsData;
  dashboardUrl: string;
  /** The tracked /api/digest/open/<send id> link; falls back to dashboardUrl. */
  openUrl?: string;
  /** Whether the recipient may open the dashboard: off → no button. */
  links: boolean;
  previewFor?: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDay = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
const shortDay = (day: string) => `${Number(day.slice(8, 10))} ${SHORT[Number(day.slice(5, 7)) - 1]}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const header = (text: string): SlackBlock => ({ type: "header", text: { type: "plain_text", text: `${HEADER_EMOJI} ${text}`, emoji: true } });
const section = (text: string): SlackBlock => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string): SlackBlock => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

const toolLabel = (t: RecToolResult["tool"]) => (t === "chatgpt_business" ? "ChatGPT" : VENDOR_LABEL[t]);

function item(r: RecRow): string {
  const dept = escapeMrkdwn(r.department ?? "Unattributed");
  return `• *${formatWholeUsd(r.savingUsd)}* ${escapeMrkdwn(r.name)}, ${dept} · ${r.pattern}${r.newThisWeek ? " · new this week" : ""}`;
}

function toolSection(t: RecToolResult): SlackBlock {
  const label = toolLabel(t.tool);
  if (t.rows.length === 0) return section(`*${label} · nobody over the line*`);
  const heading = `*${label} · ${plural(t.rows.length, "person", "people")} · Standard → Premium is +${formatWholeUsd(t.stepUpUsd)} a month*`;
  const lines = t.rows.slice(0, REC_LIST_MAX).map(item);
  if (t.rows.length > REC_LIST_MAX) lines.push(`… and ${t.rows.length - REC_LIST_MAX} more`);
  return section(`${heading}\n${lines.join("\n")}`);
}

function caveat(d: RecommendationsData): string {
  const lead = "Amounts are the potential saving: extra spend minus the step up. Premium would have cost less, it would not have covered all of it.";
  const cursor = d.rosterAsOf.cursor;
  if (!d.cursorRosterStale) return `${lead} Seat tiers from the latest rosters${cursor ? ` (Cursor export ${shortDay(cursor)})` : ""}.`;
  return `${lead} ${cursor ? `Cursor seat tiers from ${shortDay(cursor)} — upload a newer members export.` : "No Cursor members export uploaded yet."}`;
}

export function renderRecommendations(i: RecommendationsMessageInput): RenderedDigest {
  const { data } = i;
  const people = data.tools.reduce((s, t) => s + t.rows.length, 0);
  const saving = data.tools.reduce((s, t) => s + t.totalSavingUsd, 0);
  const totals = `${plural(people, "person", "people")}, ${formatWholeUsd(saving)} potential saving a month`;

  const blocks: SlackBlock[] = [header(`Premium seat recommendations · four weeks to Sunday ${longDay(data.sunday)}`)];
  if (people === 0) {
    blocks.push(section("Nobody on a Standard seat is over the line this week"));
  } else {
    blocks.push(section(`People on a Standard seat whose extra spend over the last four weeks was more than the step up to Premium.\n${totals}.`));
    for (const t of data.tools) blocks.push(toolSection(t));
    blocks.push(context(caveat(data)));
    if (i.links) {
      blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open recommendations" }, url: i.openUrl ?? i.dashboardUrl }] });
    }
  }

  const text = `Premium seat recommendations: ${totals}`;
  if (!i.previewFor) return { blocks, text };
  return {
    blocks: [context(`Preview for *${escapeMrkdwn(i.previewFor)}*`), ...blocks],
    text: `[Preview for ${escapeMrkdwn(i.previewFor)}] ${text}`,
  };
}
