import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { monthToDate, runAllSyncs } from "@/lib/ingest/run-all";
import { reattributeUnmatched } from "@/lib/ingest/reattribute";
import { FACTS_TAG } from "@/lib/queries/cached";

export const dynamic = "force-dynamic";
// Backfills fan out over many vendor calls with retry backoff — give the
// function the full window rather than the platform default.
export const maxDuration = 300;

/**
 * Daily sync orchestrator (Vercel Cron, see vercel.json). Each source is
 * isolated (spec §8): one vendor's API failure never aborts the others.
 * Authenticated by CRON_SECRET (Vercel sets the Authorization header);
 * fails closed when the secret is unset.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Default: refresh the whole current month (self-healing). Optional
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD overrides it for backfilling other months.
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const window = from && to ? { startDate: from, endDate: to } : monthToDate(new Date());
  // Optional ?source=cursor (comma-separated) to backfill a single source
  // without disturbing the others.
  const only = url.searchParams.get("source")?.split(",").map((s) => s.trim()).filter(Boolean);

  const supabase = getSupabaseAdminClient();
  const results = await runAllSyncs(supabase, window, only);

  // After syncing the roster + spend, re-resolve any still-unmatched facts
  // against the current employees (clears facts ingested before a person
  // existed — e.g. people the Okta spine added). Isolated so a failure here
  // never masks the sync results.
  let reattribution: Awaited<ReturnType<typeof reattributeUnmatched>> | { error: string };
  try {
    reattribution = await reattributeUnmatched(supabase);
  } catch (err) {
    reattribution = { error: err instanceof Error ? err.message : String(err) };
  }

  // The sync (and reattribution) rewrote facts — serve fresh data from here on.
  revalidateTag(FACTS_TAG, "max");

  return NextResponse.json({ ranAt: new Date().toISOString(), window, results, reattribution });
}
