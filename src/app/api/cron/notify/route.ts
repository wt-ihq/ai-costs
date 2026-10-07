import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { renderChartPng } from "@/lib/notify/chart-image";
import { runNotify } from "@/lib/notify/run-notify";
import { resolveRunDate } from "@/lib/notify/schedule";
import { supabaseNotifyStore } from "@/lib/notify/store";
import { notifyMode } from "@/lib/notify/types";
import { appBaseUrl, slackClientFromEnv } from "@/lib/notify/wiring";

export const dynamic = "force-dynamic";
// Each DM is ~4 Slack calls; runNotify stops claiming at 240 s inside this.
export const maxDuration = 300;

/**
 * Slack spend digests. Vercel Cron runs this hourly at :30; each run DMs whoever
 * it's now 10:30+ for on a working day in their own Slack time zone (runNotify).
 * CRON_SECRET-gated (fails closed). SLACK_NOTIFY_MODE off|preview|live — off
 * (the default) returns without touching anything. ?date=YYYY-MM-DD replays
 * that day straight away (no 10:30 wait), preview mode only.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const mode = notifyMode();
  if (mode === "off") return NextResponse.json({ mode, skipped: "SLACK_NOTIFY_MODE is off" });

  const runDate = resolveRunDate(new URL(req.url).searchParams.get("date"), mode, new Date());
  if ("error" in runDate) return NextResponse.json({ error: runDate.error }, { status: 400 });

  try {
    const result = await runNotify({
      store: supabaseNotifyStore(getSupabaseAdminClient()),
      slack: slackClientFromEnv(),
      renderChart: renderChartPng,
      mode,
      previewEmail: process.env.SLACK_PREVIEW_EMAIL ?? null,
      now: runDate.now,
      replay: runDate.replay,
      baseUrl: appBaseUrl(),
    });
    return NextResponse.json({ ranAt: new Date().toISOString(), mode, ...result });
  } catch (err) {
    return NextResponse.json({ mode, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
