import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { reattributeUnmatched } from "@/lib/ingest/reattribute";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Re-attribution pass: re-resolves unmatched spend_facts against the current
 * employees roster (no vendor fetch). Useful after a roster change such as
 * switching the identity spine to Okta. CRON_SECRET-gated like /api/cron/sync
 * (fails closed when the secret is unset).
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await reattributeUnmatched(getSupabaseAdminClient());
  return NextResponse.json({ ranAt: new Date().toISOString(), ...result });
}
