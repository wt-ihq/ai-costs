import { chartLayout, type ChartLayout } from "./chart";
import type { Digest } from "./digest";
import { chartTitle, renderDigest, type ChartFileIds, type RenderedDigest } from "./render";
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

const failureCode = (err: unknown): string =>
  (err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : String(err)).slice(0, 200);

/** Best effort: a chart that fails to render or upload is simply left out. */
async function uploadCharts(slack: SlackClient, renderChart: RenderChart, d: Digest, log: (m: string) => void): Promise<ChartFileIds> {
  const files: ChartFileIds = {};
  for (const [section, layout] of Object.entries(chartLayoutsFor(d)) as ["you" | "reports", ChartLayout | undefined][]) {
    if (!layout) continue;
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

/** Only a Slack rejection that arrived as an answer (not a 5xx) proves the message was not posted. */
const isDefinitiveRejection = (err: unknown): boolean => err instanceof SlackApiError && !err.code.startsWith("http_5");

const isInvalidBlocks = (err: unknown): boolean => err instanceof SlackApiError && err.code.startsWith("invalid_blocks");

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Slack sometimes rejects an image block whose upload has not finished propagating; give it a moment. */
export const IMAGE_RETRY_DELAY_MS = 1500;

/**
 * Upload charts, DM the digest. If Slack rejects the image blocks, retry the
 * same blocks once after a short wait (the upload may still be propagating),
 * then fall back to text only. Returns the message ts.
 *
 * Every postMessage failure is either a definitive Slack rejection (rethrown
 * as is → nothing was posted) or a PostOutcomeUnknownError (Slack may have
 * accepted it).
 */
export async function deliverDigest(args: {
  slack: SlackClient;
  renderChart: RenderChart;
  slackUserId: string;
  digest: Digest;
  previewFor?: string;
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const { slack, digest, previewFor } = args;
  const log = args.log ?? console.log;
  const sleep = args.sleep ?? defaultSleep;
  const files = await uploadCharts(slack, args.renderChart, digest, log);
  const channel = await slack.openDm(args.slackUserId);

  async function post(r: RenderedDigest): Promise<string> {
    try {
      return await slack.postMessage(channel, r.blocks, r.text);
    } catch (err) {
      if (isDefinitiveRejection(err)) throw err;
      throw new PostOutcomeUnknownError(failureCode(err), err);
    }
  }

  const rendered = renderDigest(digest, files, { previewFor });
  const hasCharts = Boolean(files.you || files.reports);
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
  const plain = renderDigest(digest, {}, { previewFor });
  return post(plain);
}
