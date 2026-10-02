import { chartLayout, type ChartLayout } from "./chart";
import type { Digest, TeamDigest } from "./digest";
import { chartTitle, renderDigest, renderTeamDigest, teamChartTitle, type RenderedDigest } from "./render";
import { SlackApiError, type SlackClient } from "./slack-client";
import type { NotifyStore } from "./store";
import type { NotifyEmployee } from "./types";

export type RenderChart = (layout: ChartLayout) => Promise<Uint8Array<ArrayBuffer>>;

/** One chart per section, each titled with whose numbers it shows. */
export function chartLayoutsFor(d: Digest): { you: ChartLayout; reports?: ChartLayout } {
  return {
    you: chartLayout(chartTitle("you", d), d.you.chart, d.you.chartTools, d.you.byTool),
    ...(d.reports ? { reports: chartLayout(chartTitle("reports", d), d.reports.chart, d.reports.chartTools, d.reports.byTool) } : {}),
  };
}

/** A team digest has one chart, for the whole team. */
export function chartLayoutsForTeam(d: TeamDigest): { team: ChartLayout } {
  return { team: chartLayout(teamChartTitle(d), d.team.chart, d.team.chartTools, d.team.byTool) };
}

const failureCode = (err: unknown): string =>
  (err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : String(err)).slice(0, 200);

/** Best effort: a chart that fails to render or upload is simply left out. */
async function uploadCharts(
  slack: SlackClient,
  renderChart: RenderChart,
  layouts: Record<string, ChartLayout>,
  log: (m: string) => void,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [section, layout] of Object.entries(layouts)) {
    try {
      files[section] = await slack.uploadImage(await renderChart(layout), `ai-spend-${section}.png`, layout.title);
    } catch (err) {
      log(`[notify] chart ${section} skipped: ${failureCode(err)}`);
    }
  }
  return files;
}

/** Trust a cached "not found" for a week before asking Slack again. */
export const SLACK_NOT_FOUND_TTL_MS = 7 * 86_400_000;

export async function resolveSlackUser(
  store: Pick<NotifyStore, "slackUser" | "saveSlackUser">,
  slack: SlackClient,
  e: NotifyEmployee,
  now: Date,
): Promise<string | null> {
  const cached = await store.slackUser(e.id);
  if (cached?.slackUserId) return cached.slackUserId;
  if (cached && now.getTime() - Date.parse(cached.lookedUpAt) < SLACK_NOT_FOUND_TTL_MS) return null;
  const id = await slack.lookupUserByEmail(e.email);
  await store.saveSlackUser(e.id, id);
  return id;
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
  render: (fileIds: Record<string, string>) => RenderedDigest;
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const { slack, render } = args;
  const log = args.log ?? console.log;
  const sleep = args.sleep ?? defaultSleep;
  const files = await uploadCharts(slack, args.renderChart, args.layouts, log);
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
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** A person's digest (the cron's send, the preview redirect, and admin test sends). */
export function deliverDigest(args: DeliverArgs & { digest: Digest; previewFor?: string }): Promise<string> {
  const { digest, previewFor, banner } = args;
  return deliverRendered({ ...args, layouts: chartLayoutsFor(digest), render: (files) => renderDigest(digest, files, { previewFor, banner }) });
}

/** A whole team's digest (admin test sends only). */
export function deliverTeamDigest(args: DeliverArgs & { digest: TeamDigest }): Promise<string> {
  const { digest, banner } = args;
  return deliverRendered({ ...args, layouts: chartLayoutsForTeam(digest), render: (files) => renderTeamDigest(digest, files, { banner }) });
}
