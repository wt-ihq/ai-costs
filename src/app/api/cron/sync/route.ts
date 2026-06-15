import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Daily sync orchestrator (Vercel Cron, see vercel.json).
 *
 * Source isolation (spec §8): each vendor pull is wrapped so one vendor's API
 * failure doesn't abort the others. Each source: fetch -> persist raw_payload
 * -> normalize -> resolve identities -> upsert spend_facts -> record sync_run.
 *
 * Authenticated by CRON_SECRET (Vercel sets the Authorization header on cron).
 */
const SOURCES = ["cursor", "anthropic", "openai", "hibob"] as const;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (secret && authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const results: Record<string, "ok" | "failed" | "todo"> = {};
  for (const source of SOURCES) {
    try {
      // TODO: per-source fetch + normalize + upsert. See src/lib/ingest/*.
      results[source] = "todo";
    } catch (err) {
      results[source] = "failed";
      console.error(`[sync] ${source} failed`, err);
      // continue — isolation: do not abort remaining sources
    }
  }

  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}
