import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { recentWindow, runAllSyncs } from "@/lib/ingest/run-all";

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

  const results = await runAllSyncs(getSupabaseAdminClient(), recentWindow(new Date()));
  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}
