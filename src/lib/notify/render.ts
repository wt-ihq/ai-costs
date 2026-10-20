import { formatUsd } from "@/lib/utils";
import type { ChartHeadline } from "./chart";
import { round2, type CompanyDigest, type CompanyUsageSection, type Digest, type DigestSection, type FixedCostsSection, type MonthTotal, type ReportsSection, type TeamDigest, type ToolAmount } from "./digest";
import { introFor } from "./intro";
import { CADENCE_UNIT, CHART_SPAN, type DigestPeriod } from "./schedule";
import type { Cadence } from "./types";

export type SlackBlock = Record<string, unknown>;
/** Slack file ids of the uploaded charts (absent = send without that image). */
export interface ChartFileIds { you?: string; reports?: string }
export interface TeamChartFileIds { team?: string }
export interface CompanyChartFileIds { company?: string }
export interface RenderedDigest { blocks: SlackBlock[]; text: string }
/**
 * previewFor: the cron's preview mode ("would send to X"). banner: a context line above everything
 * (admin test sends) — the plain-text fallback carries it too, as "[banner] ".
 */
export interface RenderOpts {
  previewFor?: string;
  banner?: string;
  /**
   * Whether the recipient can open the dashboard (dashboard-access.ts). Off by default: no "Open in
   * dashboard" button, and names/teams as plain text, for anyone who'd only hit "no access".
   */
  links?: boolean;
  /** The send's tracked "Open in dashboard" link (/api/digest/open/<send id>); absent = link straight to the dashboard. */
  openUrl?: string;
  /** The person's first live message: the intro (intro.ts) above the digest, with their first name and cadences. */
  intro?: { name: string | null; cadences: Cadence[] };
}

const TOOLS_MAX = 4;
const CONTEXT_MAX = 10; // Slack's element cap per context block
const HEADER_MAX = 150; // Slack's plain_text cap for a header block

/** Slack mrkdwn treats &, < and > as control characters — escape every user-supplied string. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The headline drawn into a section's chart: total, direction, and the change after the arrow.
 * `compareTo` is the period's DigestPeriod.compareTo ("previous week", or "Friday" for a Monday's daily).
 */
export function chartHeadline(s: DigestSection, compareTo: string): ChartHeadline {
  const total = formatUsd(s.headlineUsd);
  if (s.deltaPct === null) {
    const when = compareTo.startsWith("previous ") ? `the ${compareTo}` : `on ${compareTo}`;
    return { total, trend: null, change: s.headlineUsd > 0 ? `up from $0 ${when}` : "no spend" };
  }
  if (Math.abs(s.deltaPct) < 0.5) return { total, trend: null, change: `no change vs ${compareTo}` };
  return { total, trend: s.deltaPct > 0 ? "up" : "down", change: `${Math.round(Math.abs(s.deltaPct)).toLocaleString("en-US")}% vs ${compareTo}` };
}

export function deltaText(s: DigestSection, compareTo: string): string {
  const { trend, change } = chartHeadline(s, compareTo);
  return trend ? `${trend === "up" ? "▲" : "▼"} ${change}` : change;
}

const people = (n: number) => `${n} ${n === 1 ? "PERSON" : "PEOPLE"}`;

/** The chart's title sits directly above the headline total, so it names THAT number's period, not the bars' span. */
export function chartTitle(section: "you" | "reports", d: Digest): string {
  const s = section === "you" ? d.you : d.reports!;
  const who = section === "you" ? "YOU" : `YOUR REPORTS (${people(d.reports!.headcount)})`;
  return `${who} · ${s.basis.toUpperCase()}, ${d.period.label.toUpperCase()}`;
}

export function teamChartTitle(d: TeamDigest): string {
  return `${d.department.toUpperCase()} (${people(d.team.headcount)}) · ${d.team.basis.toUpperCase()}, ${d.period.label.toUpperCase()}`;
}

export function companyChartTitle(d: CompanyDigest): string {
  return `COMPANY (${people(d.usage.headcount)}) · ${d.usage.basis.toUpperCase()}, ${d.period.label.toUpperCase()}`;
}

/** The bars' span, captioned just above them. */
export function chartSpan(c: Cadence): string {
  return `LAST ${CHART_SPAN[c]} ${CADENCE_UNIT[c].toUpperCase()}S`;
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

/** A name linked to its dashboard page, or plain for a recipient without access. */
const named = (href: string, name: string, links: boolean) => (links ? `<${href}|${escapeMrkdwn(name)}>` : escapeMrkdwn(name));

function topLine(r: ReportsSection, unit: string, links: boolean): string {
  if (!r.top.length) return `No usage from your reports this ${unit}`;
  const names = r.top.map((p) => `${named(p.href, p.name, links)} ${formatUsd(p.usd)}`);
  if (r.othersCount) names.push(`+${r.othersCount} others ${formatUsd(r.othersUsd)}`);
  const line = names.join(" · ");
  // A manager of managers: their teams first ("Team · Lead (people)"), then the top people.
  if (!r.branches?.length) return line;
  const teams = r.branches.map((b) => `${escapeMrkdwn(b.team ?? "No team")} · ${named(b.href, b.name, links)}${b.headcount > 1 ? ` (${b.headcount})` : ""} ${formatUsd(b.usd)}`);
  if (r.otherBranchesCount) teams.push(`+${r.otherBranchesCount} more ${formatUsd(r.otherBranchesUsd ?? 0)}`);
  return `*By team*\n${teams.map((t) => `• ${t}`).join("\n")}\n*Top people:* ${line}`;
}

/**
 * A group's top people. "Others" counts people only; spend that belongs to no member (`teamLevelUsd`)
 * is its own item, named by `restLabel`, so neither is hidden inside the other. Rounding cents alone
 * show nothing. Null when there is nothing to list.
 */
function peopleLine(r: ReportsSection, restLabel: string, links: boolean): string | null {
  const parts = r.top.map((p) => `${named(p.href, p.name, links)} ${formatUsd(p.usd)}`);
  const rest = r.teamLevelUsd ?? 0;
  if (r.othersCount) parts.push(`+${r.othersCount} others ${formatUsd(Math.max(0, round2(r.othersUsd - rest)))}`);
  if (rest > 0) parts.push(`${restLabel} ${formatUsd(rest)}`);
  return parts.length ? parts.join(" · ") : null;
}

const teamTopLine = (r: ReportsSection, unit: string, links: boolean): string => peopleLine(r, "team-level costs", links) ?? `No usage from this team this ${unit}`;

/** The company's top teams (linked when the recipient can follow them), the rest, then usage with no team (Explore's "Unattributed") apart. */
function teamsLine(u: CompanyUsageSection, links: boolean): string | null {
  const parts = u.teams.map((t) => `${named(t.href, t.department, links)} ${formatUsd(t.usd)}`);
  if (u.otherTeamsCount) parts.push(`+${u.otherTeamsCount} ${u.otherTeamsCount === 1 ? "team" : "teams"} ${formatUsd(u.otherTeamsUsd)}`);
  if (u.unattributedUsd > 0) parts.push(`unattributed ${formatUsd(u.unattributedUsd)}`);
  return parts.length ? parts.join(" · ") : null;
}

function companyLines(u: CompanyUsageSection, unit: string, links: boolean): string {
  const lines = [teamsLine(u, links), peopleLine(u, "not tied to a person", links)].filter((l): l is string => l !== null);
  return lines.length ? lines.join("\n") : `No usage this ${unit}`;
}

/** With a chart, the headline is drawn big into the image, so the text is just the label; without one it stays as text. */
function sectionBlocks(label: string, s: DigestSection, fileId: string | undefined, title: string, compareTo: string, extra?: string): SlackBlock[] {
  const change = deltaText(s, compareTo);
  const out: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: fileId ? `*${label}*` : `*${label}*\n*${formatUsd(s.headlineUsd)}* ${s.basis} · ${change}` } },
  ];
  if (fileId) out.push({ type: "image", slack_file: { id: fileId }, alt_text: `${title}: ${formatUsd(s.headlineUsd)} · ${change}` });
  if (extra) out.push({ type: "section", text: { type: "mrkdwn", text: extra } });
  const lines = [toolsLine(s.byTool), monthLine(s)].filter((l): l is string => l !== null);
  if (lines.length) out.push(context(lines));
  return out;
}

const FIXED_LABEL = "SEATS & SUBSCRIPTIONS";
const SHARE_OF_MONTH: Record<Cadence, string> = { daily: "a day's share of the monthly bill", weekly: "a week's share of the monthly bill", monthly: "" };

/** "October $18,277 · ▼ 1% vs September": the bill's real movement. Nothing before it → the figure alone. */
function monthTotalLine(m: MonthTotal): string {
  if (m.deltaPct === null) return `${m.label} ${formatUsd(m.usd)}`;
  const change = Math.abs(m.deltaPct) < 0.5 ? "no change" : `${m.deltaPct > 0 ? "▲" : "▼"} ${Math.round(Math.abs(m.deltaPct)).toLocaleString("en-US")}%`;
  return `${m.label} ${formatUsd(m.usd)} · ${change} vs ${m.prevLabel}`;
}

/**
 * The company's seats & subscriptions, text only (a day's share is flat across a month, so a chart
 * would say nothing). A daily/weekly figure is a share of the bill (its change vs the day/week before
 * would only be the month's length), so it says so, and the month line compares whole months instead.
 */
function fixedBlocks(s: FixedCostsSection, period: DigestPeriod): SlackBlock[] {
  const change = s.monthTotal ? SHARE_OF_MONTH[period.cadence] : deltaText(s, period.compareTo);
  const lines = [toolsLine(s.byTool), s.monthTotal ? monthTotalLine(s.monthTotal) : null].filter((l): l is string => l !== null);
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${escapeMrkdwn(FIXED_LABEL)}*\n*${formatUsd(s.headlineUsd)}* ${s.basis} · ${change}` } },
    ...(lines.length ? [context(lines)] : []),
  ];
}

/** A first live message: the intro above the digest, and the notification text opens with the greeting. */
function withIntro(r: RenderedDigest, opts: RenderOpts, report: "personal" | "company", reports: "none" | "direct" | "byTeam"): RenderedDigest {
  if (!opts.intro) return r;
  const intro = introFor({ name: opts.intro.name, cadences: opts.intro.cadences, report, reports, links: !!opts.links });
  return { blocks: [...intro.blocks, ...r.blocks], text: intro.text + r.text };
}

/** Banner and/or cron preview line above the digest; the text fallback gets the same context (escaped: Slack parses it as mrkdwn). */
function withLead(r: RenderedDigest, opts: RenderOpts): RenderedDigest {
  const lead: SlackBlock[] = [];
  let prefix = "";
  if (opts.banner) {
    lead.push(context([escapeMrkdwn(opts.banner)]));
    prefix += `[${escapeMrkdwn(opts.banner)}] `;
  }
  if (opts.previewFor) {
    lead.push(context([`🔍 Preview · would send to ${escapeMrkdwn(opts.previewFor)}`]));
    prefix += `[Preview for ${escapeMrkdwn(opts.previewFor)}] `;
  }
  return lead.length ? { blocks: [...lead, ...r.blocks], text: prefix + r.text } : r;
}

/** "Open in dashboard", only for a recipient who can get in (none otherwise). */
const dashboardButton = (opts: RenderOpts, dashboardUrl: string): SlackBlock[] =>
  opts.links
    ? [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in dashboard" }, url: opts.openUrl ?? dashboardUrl, action_id: "open_dashboard" }] }]
    : [];

/** Digest → Block Kit. The admin preview renders these same blocks (block-kit-preview.tsx). */
export function renderDigest(d: Digest, files: ChartFileIds, opts: RenderOpts = {}): RenderedDigest {
  const unit = CADENCE_UNIT[d.period.cadence];
  const blocks: SlackBlock[] = [];
  blocks.push({ type: "header", text: { type: "plain_text", text: `📊 Your AI spend · ${d.period.label}`, emoji: true } });
  blocks.push(...sectionBlocks("YOU", d.you, files.you, chartTitle("you", d), d.period.compareTo));
  if (d.reports) {
    blocks.push({ type: "divider" });
    blocks.push(...sectionBlocks(`YOUR REPORTS · ${people(d.reports.headcount)}`, d.reports, files.reports, chartTitle("reports", d), d.period.compareTo, topLine(d.reports, unit, !!opts.links)));
  }
  if (d.caveats.length) blocks.push(context(d.caveats.map(escapeMrkdwn)));
  blocks.push(...dashboardButton(opts, d.dashboardUrl));

  const text =
    `Your AI spend · ${d.period.label}: you ${formatUsd(d.you.headlineUsd)} ${d.you.basis}` +
    (d.reports ? ` · your reports ${formatUsd(d.reports.headlineUsd)} ${d.reports.basis}` : "");
  const reports = !d.reports ? "none" : d.reports.branches !== undefined ? "byTeam" : "direct";
  return withLead(withIntro({ blocks, text }, opts, "personal", reports), opts);
}

/** A whole team's digest → Block Kit (admin preview and test sends; never scheduled). */
export function renderTeamDigest(d: TeamDigest, files: TeamChartFileIds, opts: RenderOpts = {}): RenderedDigest {
  const unit = CADENCE_UNIT[d.period.cadence];
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: `📊 AI spend · ${d.department} · ${d.period.label}`.slice(0, HEADER_MAX), emoji: true } },
    // Uppercase BEFORE escaping: "&amp;" must not become "&AMP;".
    ...sectionBlocks(`${escapeMrkdwn(d.department.toUpperCase())} · ${people(d.team.headcount)}`, d.team, files.team, teamChartTitle(d), d.period.compareTo, teamTopLine(d.team, unit, !!opts.links)),
  ];
  if (d.caveats.length) blocks.push(context(d.caveats.map(escapeMrkdwn)));
  blocks.push(...dashboardButton(opts, d.dashboardUrl));

  // Slack parses `text` as mrkdwn as well, so the department is escaped here (the header block is plain_text and is not).
  const text = `AI spend · ${escapeMrkdwn(d.department)} · ${d.period.label}: team ${formatUsd(d.team.headlineUsd)} ${d.team.basis}`;
  return withLead({ blocks, text }, opts);
}

/** The whole-company report → Block Kit (the cron's company DMs, the admin preview and test sends). */
export function renderCompanyDigest(d: CompanyDigest, files: CompanyChartFileIds, opts: RenderOpts = {}): RenderedDigest {
  const unit = CADENCE_UNIT[d.period.cadence];
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: `📊 Company AI spend · ${d.period.label}`, emoji: true } },
    ...sectionBlocks(`COMPANY · ${people(d.usage.headcount)}`, d.usage, files.company, companyChartTitle(d), d.period.compareTo, companyLines(d.usage, unit, !!opts.links)),
    { type: "divider" },
    ...fixedBlocks(d.fixed, d.period),
  ];
  // Monthly: both sections together, which is the Company page's total for the month.
  if (d.totalUsd !== null) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${d.period.label} total ${formatUsd(d.totalUsd)}* · usage + ${escapeMrkdwn("seats & subscriptions")}` } });
  }
  if (d.caveats.length) blocks.push(context(d.caveats.map(escapeMrkdwn)));
  blocks.push(...dashboardButton(opts, d.dashboardUrl));

  const text = `Company AI spend · ${d.period.label}: usage ${formatUsd(d.usage.headlineUsd)} · ${escapeMrkdwn("seats & subscriptions")} ${formatUsd(d.fixed.headlineUsd)}`;
  return withLead(withIntro({ blocks, text }, opts, "company", "none"), opts);
}
