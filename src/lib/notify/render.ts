import { formatUsd } from "@/lib/utils";
import type { Digest, DigestSection, ReportsSection, TeamDigest, ToolAmount } from "./digest";
import { CADENCE_UNIT, CHART_SPAN } from "./schedule";

export type SlackBlock = Record<string, unknown>;
/** Slack file ids of the uploaded charts (absent = send without that image). */
export interface ChartFileIds { you?: string; reports?: string }
export interface TeamChartFileIds { team?: string }
export interface RenderedDigest { blocks: SlackBlock[]; text: string }
/**
 * previewFor: the cron's preview mode ("would send to X"). banner: a context line above everything
 * (admin test sends) — the plain-text fallback carries it too, as "[banner] ".
 */
export interface RenderOpts { previewFor?: string; banner?: string }

const TOOLS_MAX = 4;
const CONTEXT_MAX = 10; // Slack's element cap per context block
const HEADER_MAX = 150; // Slack's plain_text cap for a header block

/** Slack mrkdwn treats &, < and > as control characters — escape every user-supplied string. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function deltaText(s: DigestSection, unit: string): string {
  if (s.deltaPct === null) return s.headlineUsd > 0 ? `up from $0 the previous ${unit}` : "no spend";
  if (Math.abs(s.deltaPct) < 0.5) return `no change vs previous ${unit}`;
  return `${s.deltaPct > 0 ? "▲" : "▼"} ${Math.round(Math.abs(s.deltaPct)).toLocaleString("en-US")}% vs previous ${unit}`;
}

const people = (n: number) => `${n} ${n === 1 ? "PERSON" : "PEOPLE"}`;

export function chartTitle(section: "you" | "reports", d: Digest): string {
  const s = section === "you" ? d.you : d.reports!;
  const who = section === "you" ? "YOU" : `YOUR REPORTS (${people(d.reports!.headcount)})`;
  const c = d.period.cadence;
  return `${who} · ${s.basis.toUpperCase()}, LAST ${CHART_SPAN[c]} ${CADENCE_UNIT[c].toUpperCase()}S`;
}

export function teamChartTitle(d: TeamDigest): string {
  const c = d.period.cadence;
  return `${d.department.toUpperCase()} (${people(d.team.headcount)}) · ${d.team.basis.toUpperCase()}, LAST ${CHART_SPAN[c]} ${CADENCE_UNIT[c].toUpperCase()}S`;
}

function toolsLine(tools: ToolAmount[]): string | null {
  if (!tools.length) return null;
  const shown = tools.slice(0, TOOLS_MAX).map((t) => `${escapeMrkdwn(t.label)} ${formatUsd(t.usd)}`);
  const rest = tools.slice(TOOLS_MAX);
  if (rest.length) shown.push(`+${rest.length} more ${formatUsd(rest.reduce((s, t) => s + t.usd, 0))}`);
  return shown.join(" · ");
}

function monthLine(s: DigestSection): string | null {
  const m = s.month;
  if (!m) return null;
  if (m.complete) return `${m.monthLabel} total ${formatUsd(m.soFarUsd)}`;
  return `${m.monthLabel} so far ${formatUsd(m.soFarUsd)}${m.projectedUsd !== null ? ` · on track for ~${formatUsd(m.projectedUsd)}` : ""}`;
}

const context = (lines: string[]): SlackBlock => ({
  type: "context",
  elements: lines.slice(0, CONTEXT_MAX).map((text) => ({ type: "mrkdwn", text })),
});

function topLine(r: ReportsSection, unit: string): string {
  if (!r.top.length) return `No usage from your reports this ${unit}`;
  const names = r.top.map((p) => `<${p.href}|${escapeMrkdwn(p.name)}> ${formatUsd(p.usd)}`);
  if (r.othersCount) names.push(`+${r.othersCount} others ${formatUsd(r.othersUsd)}`);
  return names.join(" · ");
}

/** The team's top people. Department-level costs belong to no one, so they show as their own item rather than vanish into "others". */
function teamTopLine(r: ReportsSection, unit: string): string {
  const parts = r.top.map((p) => `<${p.href}|${escapeMrkdwn(p.name)}> ${formatUsd(p.usd)}`);
  if (r.othersCount) parts.push(`+${r.othersCount} others ${formatUsd(r.othersUsd)}`);
  else if (r.othersUsd > 0) parts.push(`${r.top.length ? "+" : ""}team-level costs ${formatUsd(r.othersUsd)}`);
  return parts.length ? parts.join(" · ") : `No usage from this team this ${unit}`;
}

function sectionBlocks(label: string, s: DigestSection, fileId: string | undefined, title: string, unit: string, extra?: string): SlackBlock[] {
  const out: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${label}*\n*${formatUsd(s.headlineUsd)}* ${s.basis} · ${deltaText(s, unit)}` } },
  ];
  if (fileId) out.push({ type: "image", slack_file: { id: fileId }, alt_text: `${title}: ${formatUsd(s.headlineUsd)}` });
  if (extra) out.push({ type: "section", text: { type: "mrkdwn", text: extra } });
  const lines = [toolsLine(s.byTool), monthLine(s)].filter((l): l is string => l !== null);
  if (lines.length) out.push(context(lines));
  return out;
}

/** Banner and/or cron preview line above the digest; the text fallback gets the same context. */
function withLead(r: RenderedDigest, opts: RenderOpts): RenderedDigest {
  const lead: SlackBlock[] = [];
  let prefix = "";
  if (opts.banner) {
    lead.push(context([escapeMrkdwn(opts.banner)]));
    prefix += `[${opts.banner}] `;
  }
  if (opts.previewFor) {
    lead.push(context([`🔍 Preview · would send to ${escapeMrkdwn(opts.previewFor)}`]));
    prefix += `[Preview for ${opts.previewFor}] `;
  }
  return lead.length ? { blocks: [...lead, ...r.blocks], text: prefix + r.text } : r;
}

const dashboardButton = (url: string): SlackBlock => ({
  type: "actions",
  elements: [{ type: "button", text: { type: "plain_text", text: "Open in dashboard" }, url, action_id: "open_dashboard" }],
});

/** Digest → Block Kit. The admin preview renders these same blocks (block-kit-preview.tsx). */
export function renderDigest(d: Digest, files: ChartFileIds, opts: RenderOpts = {}): RenderedDigest {
  const unit = CADENCE_UNIT[d.period.cadence];
  const blocks: SlackBlock[] = [];
  blocks.push({ type: "header", text: { type: "plain_text", text: `📊 Your AI spend · ${d.period.label}`, emoji: true } });
  blocks.push(...sectionBlocks("YOU", d.you, files.you, chartTitle("you", d), unit));
  if (d.reports) {
    blocks.push({ type: "divider" });
    blocks.push(...sectionBlocks(`YOUR REPORTS · ${people(d.reports.headcount)}`, d.reports, files.reports, chartTitle("reports", d), unit, topLine(d.reports, unit)));
  }
  if (d.caveats.length) blocks.push(context(d.caveats.map(escapeMrkdwn)));
  blocks.push(dashboardButton(d.dashboardUrl));

  const text =
    `Your AI spend · ${d.period.label}: you ${formatUsd(d.you.headlineUsd)} ${d.you.basis}` +
    (d.reports ? ` · your reports ${formatUsd(d.reports.headlineUsd)} ${d.reports.basis}` : "");
  return withLead({ blocks, text }, opts);
}

/** A whole team's digest → Block Kit (admin preview and test sends; never scheduled). */
export function renderTeamDigest(d: TeamDigest, files: TeamChartFileIds, opts: RenderOpts = {}): RenderedDigest {
  const unit = CADENCE_UNIT[d.period.cadence];
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: `📊 AI spend · ${d.department} · ${d.period.label}`.slice(0, HEADER_MAX), emoji: true } },
    // Uppercase BEFORE escaping: "&amp;" must not become "&AMP;".
    ...sectionBlocks(`${escapeMrkdwn(d.department.toUpperCase())} · ${people(d.team.headcount)}`, d.team, files.team, teamChartTitle(d), unit, teamTopLine(d.team, unit)),
  ];
  if (d.caveats.length) blocks.push(context(d.caveats.map(escapeMrkdwn)));
  blocks.push(dashboardButton(d.dashboardUrl));

  const text = `AI spend · ${d.department} · ${d.period.label}: team ${formatUsd(d.team.headlineUsd)} ${d.team.basis}`;
  return withLead({ blocks, text }, opts);
}
