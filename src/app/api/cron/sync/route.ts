import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncCursor } from "@/lib/ingest/run-cursor";

export const dynamic = "force-dynamic";

/**
 * Daily sync orchestrator (Vercel Cron, see vercel.json).
 *
 * Source isolation (spec §8): each vendor pull is wrapped so one vendor's API
 * failure doesn't abort the others. Each source: fetch → persist raw_payload
 * → normalize → resolve identities → upsert spend_facts → record sync_run.
 *
 * Authenticated by CRON_SECRET (Vercel sets the Authorization header on cron).
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (secret && authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86_400_000); // last 7 days
  const window = {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };

  const results: Record<string, unknown> = {};

  // Cursor — live pipeline (needs CURSOR_ADMIN_API_KEY).
  try {
    results.cursor = await syncCursor(supabase, window);
  } catch (err) {
    results.cursor = { error: err instanceof Error ? err.message : String(err) };
    console.error("[sync] cursor failed", err);
  }

  // TODO: anthropic, openai, hibob — same pattern, source-isolated.
  results.anthropic = "todo";
  results.openai = "todo";
  results.hibob = "todo";

  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}
