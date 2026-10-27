import { dashboardAccessFor } from "@/lib/dashboard-access";
import { chartLayout, type ChartLayout } from "./chart";
import type { CompanyDigest, Digest, TeamDigest } from "./digest";
import { DEFAULT_TZ } from "./schedule";
import { chartHeadline, chartSpan, chartTitle, companyChartTitle, renderCompanyDigest, renderDigest, renderTeamDigest, teamChartTitle, type RenderedDigest, type RenderOpts } from "./render";
import { SlackApiError, type SlackClient } from "./slack-client";
import type { NotifyStore } from "./store";
import type { NotifyEmployee } from "./types";

export type RenderChart = (layout: ChartLayout) => Promise<Uint8Array<ArrayBuffer>>;

/** One chart per section, each titled with whose numbers it shows. */
export function chartLayoutsFor(d: Digest): { you: ChartLayout; reports?: ChartLayout; company?: ChartLayout } {
  const { compareTo } = d.period;
  const caption = chartSpan(d.period.cadence);
  return {
    you: chartLayout(chartTitle("you", d), d.you.chart, d.you.chartTools, d.you.byTool, { headline: chartHeadline(d.you, compareTo), caption }),
    ...(d.reports
      ? { reports: chartLayout(chartTitle("reports", d), d.reports.chart, d.reports.chartTools, d.reports.byTool, { headline: chartHeadline(d.reports, compareTo), caption }) }
      : {}),
    // The top of the chain: the company's usage chart, as the company report draws it.
    ...(d.company
      ? { company: chartLayout(companyChartTitle({ usage: d.company.usage }), d.company.usage.chart, d.company.usage.chartTools, d.company.usage.byTool, { headline: chartHeadline(d.company.usage, compareTo), caption }) }
      : {}),
  };
}

/** A team digest has one chart, for the whole team. */
export function chartLayoutsForTeam(d: TeamDigest): { team: ChartLayout } {
  const headline = chartHeadline(d.team, d.period.compareTo);
  return { team: chartLayout(teamChartTitle(d), d.team.chart, d.team.chartTools, d.team.byTool, { headline, caption: chartSpan(d.period.cadence) }) };
}

/** The company report has one chart, of its usage (seats & subscriptions are text only). */
export function chartLayoutsForCompany(d: CompanyDigest): { company: ChartLayout } {
  const headline = chartHeadline(d.usage, d.period.compareTo);
  return { company: chartLayout(companyChartTitle(d), d.usage.chart, d.usage.chartTools, d.usage.byTool, { headline, caption: chartSpan(d.period.cadence) }) };
}

const failureCode = (err: unknown): string =>
  (err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : String(err)).slice(0, 200);

export type RenderBanner = () => Promise<Uint8Array<ArrayBuffer>>;

/** Best effort: an image (chart or banner) that fails to render or upload is simply left out. */
async function uploadImages(
  slack: SlackClient,
  images: Record<string, { render: () => Promise<Uint8Array<ArrayBuffer>>; title: string }>,
  log: (m: string) => void,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [section, image] of Object.entries(images)) {
    try {
      files[section] = await slack.uploadImage(await image.render(), `ai-spend-${section}.png`, image.title);
    } catch (err) {
      log(`[notify] image ${section} skipped: ${failureCode(err)}`);
    }
  }
  return files;
}

/**
 * Who can open the dashboard, for showing its button and links (dashboard-access.ts). An unreadable
 * list is logged and fails closed — admins only — rather than holding up the send.
 */
export async function loadDashboardAccess(
  store: Pick<NotifyStore, "dashboardAccess">,
  adminEmails: readonly string[],
  log: (m: string) => void,
): Promise<(email: string) => boolean> {
  let allowlist: ReadonlySet<string> | null = null;
  try {
    allowlist = await store.dashboardAccess();
  } catch (err) {
    log(`[notify] dashboard access list unreadable, links for admins only: ${failureCode(err)}`);
  }
  return dashboardAccessFor(adminEmails, allowlist);
}

/** Ask Slack about a person again after a week: a not-found may have joined, a found one may have changed time zone. */
export const SLACK_USER_TTL_MS = 7 * 86_400_000;

export interface SlackRecipient { slackUserId: string; tz: string | null }

/** The person's Slack id and time zone, cached in slack_users. A known person keeps being served through a Slack error. */
export async function resolveSlackUser(
  store: Pick<NotifyStore, "slackUser" | "saveSlackUser">,
  slack: SlackClient,
  e: NotifyEmployee,
  now: Date,
): Promise<SlackRecipient | null> {
  const cached = await store.slackUser(e.id);
  const fresh = !!cached && now.getTime() - Date.parse(cached.lookedUpAt) < SLACK_USER_TTL_MS;
  if (fresh && cached.slackUserId && cached.tz) return { slackUserId: cached.slackUserId, tz: cached.tz };
  if (fresh && !cached.slackUserId) return null;
  let found: Awaited<ReturnType<SlackClient["lookupUserByEmail"]>>;
  try {
    found = await slack.lookupUserByEmail(e.email);
  } catch (err) {
    if (cached?.slackUserId) return { slackUserId: cached.slackUserId, tz: cached.tz };
    throw err;
  }
  // No zone from Slack counts as London (as sendDay would) — and is cached as such, not re-asked every hour.
  const user = found && { id: found.id, tz: found.tz ?? DEFAULT_TZ };
  await store.saveSlackUser(e.id, user);
  return user ? { slackUserId: user.id, tz: user.tz } : null;
}

/**
 * chat.postMessage failed in a way that does not tell us whether Slack accepted
 * the message (network error, timeout, unparseable body, HTTP 5xx). The DM may
 * have gone out, so the caller must leave the send row pending — never
 * retryable. Never twice beats always once.
 */
export class PostOutcomeUnknownError extends Error {
  constructor(readonly code: string, cause?: unknown) {
    super(`chat.postMessage outcome unknown: ${code}`, { cause });
    this.name = "PostOutcomeUnknownError";
  }
}

/** Slack documents these chat.postMessage errors as "some aspect of the operation may have succeeded", so the DM may have gone out. */
const AMBIGUOUS_SLACK_CODES: ReadonlySet<string> = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout"]);

/** Only a Slack rejection that arrived as a clear answer (not a 5xx or an ambiguous code) proves the message was not posted. */
const isDefinitiveRejection = (err: unknown): boolean =>
  err instanceof SlackApiError && !err.code.startsWith("http_5") && !AMBIGUOUS_SLACK_CODES.has(err.code);

const isInvalidBlocks = (err: unknown): boolean => err instanceof SlackApiError && err.code.startsWith("invalid_blocks");

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Slack sometimes rejects an image block whose upload has not finished propagating; give it a moment. */
export const IMAGE_RETRY_DELAY_MS = 1500;

/**
 * Upload charts, DM the rendered digest. If Slack rejects the image blocks, retry the
 * same blocks once after a short wait (the upload may still be propagating),
 * then fall back to text only. Returns the message ts.
 *
 * `render` turns the uploaded chart file ids (by `layouts` key; absent = that chart was
 * left out) into the message. Every postMessage failure is either a definitive Slack
 * rejection (rethrown as is → nothing was posted) or a PostOutcomeUnknownError (Slack
 * may have accepted it).
 */
export async function deliverRendered(args: {
  slack: SlackClient;
  renderChart: RenderChart;
  slackUserId: string;
  layouts: Record<string, ChartLayout>;
  /** A first message's welcome banner, uploaded as `banner` beside the charts. */
  renderBanner?: RenderBanner;
  render: (fileIds: Record<string, string>) => RenderedDigest;
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const { slack, render } = args;
  const log = args.log ?? console.log;
  const sleep = args.sleep ?? defaultSleep;
  const images: Record<string, { render: () => Promise<Uint8Array<ArrayBuffer>>; title: string }> = {};
  if (args.renderBanner) images.banner = { render: args.renderBanner, title: "AI Spend" };
  for (const [section, layout] of Object.entries(args.layouts)) images[section] = { render: () => args.renderChart(layout), title: layout.title };
  const files = await uploadImages(slack, images, log);
  const channel = await slack.openDm(args.slackUserId);

  async function post(r: RenderedDigest): Promise<string> {
    try {
      return await slack.postMessage(channel, r.blocks, r.text);
    } catch (err) {
      if (isDefinitiveRejection(err)) throw err;
      throw new PostOutcomeUnknownError(failureCode(err), err);
    }
  }

  const rendered = render(files);
  const hasCharts = Object.keys(files).length > 0;
  try {
    return await post(rendered);
  } catch (err) {
    if (!hasCharts || !isInvalidBlocks(err)) throw err;
  }

  log("[notify] image blocks rejected; retrying with charts once");
  await sleep(IMAGE_RETRY_DELAY_MS);
  try {
    return await post(rendered);
  } catch (err) {
    if (!isInvalidBlocks(err)) throw err;
  }

  log("[notify] image blocks rejected again; resending without charts");
  return post(render({}));
}

interface DeliverArgs {
  slack: SlackClient;
  renderChart: RenderChart;
  slackUserId: string;
  banner?: string; // admin test sends: a context line above the digest
  openUrl?: string; // scheduled sends: the tracked "Open in dashboard" link
  links?: boolean; // the recipient can open the dashboard: show its button and links (RenderOpts.links)
  intro?: RenderOpts["intro"]; // their first live message: the intro above the digest
  renderBanner?: RenderBanner; // with an intro: the welcome banner image (left out without one)
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** A person's digest (the cron's send, the preview redirect, and admin test sends). */
export function deliverDigest(args: DeliverArgs & { digest: Digest; previewFor?: string }): Promise<string> {
  const { digest, previewFor, banner, openUrl, links, intro } = args;
  return deliverRendered({
    ...args,
    renderBanner: intro ? args.renderBanner : undefined,
    layouts: chartLayoutsFor(digest),
    render: (files) => renderDigest(digest, files, { previewFor, banner, openUrl, links, intro }),
  });
}

/** A whole team's digest (admin test sends only). */
export function deliverTeamDigest(args: DeliverArgs & { digest: TeamDigest }): Promise<string> {
  const { digest, banner, links } = args;
  return deliverRendered({ ...args, layouts: chartLayoutsForTeam(digest), render: (files) => renderTeamDigest(digest, files, { banner, links }) });
}

/** The whole-company report (the cron's company sends and admin test sends). */
export function deliverCompanyDigest(args: DeliverArgs & { digest: CompanyDigest; previewFor?: string }): Promise<string> {
  const { digest, previewFor, banner, openUrl, links, intro } = args;
  return deliverRendered({
    ...args,
    renderBanner: intro ? args.renderBanner : undefined,
    layouts: chartLayoutsForCompany(digest),
    render: (files) => renderCompanyDigest(digest, files, { previewFor, banner, openUrl, links, intro }),
  });
}
