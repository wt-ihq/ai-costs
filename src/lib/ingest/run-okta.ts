import type { SupabaseClient } from "@supabase/supabase-js";
import { isSkippedOktaUser, normalizeOkta } from "@/lib/ingest/normalizers/okta";
import { fetchOktaUsers, type OktaFetcher } from "@/lib/ingest/sources/okta";
import { finishSyncRun, removeSkippedEmployees, saveRawPayload, startSyncRun, upsertEmployees } from "@/lib/ingest/persist";

/**
 * Okta identity pipeline (replaces HiBob): fetch users → persist raw →
 * normalize → upsert employees (matched by okta_id, then email — see
 * persist.ts:upsertEmployees). Department comes straight from
 * the Okta profile, so there's no named-list resolution step. Bot accounts
 * (by Okta Title — normalizers/okta.ts:SKIPPED_OKTA_TITLES) are left out, and
 * any row already stored for one is removed. The fetcher is injected so
 * tests/proofs run against fixtures.
 */
export async function syncOkta(
  supabase: SupabaseClient,
  fetcher: OktaFetcher = fetchOktaUsers,
): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "okta");
  try {
    const raw = await fetcher();
    await saveRawPayload(supabase, "okta", runId, raw);
    const employees = normalizeOkta(raw);
    const rowsWritten = await upsertEmployees(supabase, employees as unknown as Record<string, unknown>[]);
    const skipped = raw.users.filter(isSkippedOktaUser).flatMap((u) => (u.id ? [u.id] : []));
    const { removed, kept } = await removeSkippedEmployees(supabase, skipped);
    if (removed) console.log(`[okta] removed ${removed} stored bot account(s)`);
    if (kept.length) console.warn(`[okta] kept bot account okta_id ${kept.join(", ")}: still referenced (spend, keys or seats)`);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
