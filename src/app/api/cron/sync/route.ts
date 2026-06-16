import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { monthToDate, runAllSyncs } from "@/lib/ingest/run-all";

export const dynamic = "force-dynamic";

/**
 * Daily sync orchestrator (Vercel Cron, see vercel.json). Each source is
 * isolated (spec §8): one vendor's API failure never aborts the others.
 * Authenticated by CRON_SECRET (Vercel sets the Authorization header).
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Default: refresh the whole current month (self-healing). Optional
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD overrides it for backfilling other months.
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const window = from && to ? { startDate: from, endDate: to } : monthToDate(new Date());

  const results = await runAllSyncs(getSupabaseAdminClient(), window);
  return NextResponse.json({ ranAt: new Date().toISOString(), window, results });
}
