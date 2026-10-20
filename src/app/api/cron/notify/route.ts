import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { parseAdminEmails } from "@/lib/dashboard-access";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { renderChartPng, renderWelcomeBannerPng } from "@/lib/notify/chart-image";
import { runNotify } from "@/lib/notify/run-notify";
import { runReminders } from "@/lib/notify/run-reminders";
import { resolveRunDate } from "@/lib/notify/schedule";
import { supabaseNotifyStore } from "@/lib/notify/store";
import { notifyMode } from "@/lib/notify/types";
import { appBaseUrl, slackClientFromEnv } from "@/lib/notify/wiring";

export const dynamic = "force-dynamic";
// Each DM is ~4 Slack calls; runNotify stops claiming at 240 s inside this.
export const maxDuration = 300;

/**
 * Slack spend digests. Vercel Cron runs this hourly at :30; each run first sends the update
 * reminders that are due (Monday 09:30 / the month's last working day 15:00 — runReminders), then
 * DMs whoever it's now 10:30+ for on a working day in their own Slack time zone (runNotify).
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
    const deps = {
      store: supabaseNotifyStore(getSupabaseAdminClient()),
      slack: slackClientFromEnv(),
      renderChart: renderChartPng,
      renderBanner: renderWelcomeBannerPng,
      mode,
      previewEmail: process.env.SLACK_PREVIEW_EMAIL ?? null,
      now: runDate.now,
      replay: runDate.replay,
      baseUrl: appBaseUrl(),
      adminEmails: parseAdminEmails(process.env.ADMIN_EMAILS),
    };
    // Reminders first: tiny, and their 09:30 slot is before the digests' 10:30.
    const reminders = await runReminders(deps);
    const result = await runNotify(deps);
    return NextResponse.json({ ranAt: new Date().toISOString(), mode, ...result, reminders });
  } catch (err) {
    return NextResponse.json({ mode, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
