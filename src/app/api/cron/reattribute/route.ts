import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { reattributeUnmatched } from "@/lib/ingest/reattribute";

export const dynamic = "force-dynamic";

/**
 * Re-attribution pass: re-resolves unmatched spend_facts against the current
 * employees roster (no vendor fetch). Useful after a roster change such as
 * switching the identity spine to Okta. CRON_SECRET-gated like /api/cron/sync.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await reattributeUnmatched(getSupabaseAdminClient());
  return NextResponse.json({ ranAt: new Date().toISOString(), ...result });
}
