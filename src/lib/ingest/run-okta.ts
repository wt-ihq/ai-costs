import type { SupabaseClient } from "@supabase/supabase-js";
import { isOktaLeaverStatus, normalizeOkta, type OktaUser } from "@/lib/ingest/normalizers/okta";
import { fetchOktaGroupMembers, fetchOktaUsers, type OktaFetcher, type OktaGroupFetcher } from "@/lib/ingest/sources/okta";
import { fetchStoredOktaIds, finishSyncRun, removeOktaEmployees, saveRawPayload, startSyncRun, upsertEmployees } from "@/lib/ingest/persist";
import { SchemaDriftError } from "@/lib/ingest/types";

/**
 * The Okta groups whose members are the dashboard's people: employees and outsourced suppliers.
 * Everyone else in Okta (service accounts, test users, external collaborators) is left out.
 */
export const PEOPLE_GROUPS = ["Staff", "Outsourced Suppliers"] as const;

/** Okta ids of everyone in the people groups. A group that is missing, renamed or ambiguous (the fetcher throws) or empty fails the sync. */
export async function peopleGroupIds(fetchGroup: OktaGroupFetcher): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const name of PEOPLE_GROUPS) {
    const members = (await fetchGroup(name)).flatMap((m) => (m.oktaId ? [m.oktaId] : []));
    if (members.length === 0) throw new Error(`Okta group "${name}" has no members: not syncing rather than dropping everyone`);
    for (const id of members) ids.add(id);
  }
  return ids;
}

/**
 * The Okta users to sync: the people groups' members, plus stored people who have since left —
 * Okta may take a deactivated account out of its groups, and they must still be marked as left.
 * A leaver never stored isn't added.
 */
export function scopeOktaUsers(users: OktaUser[], memberIds: ReadonlySet<string>, storedOktaIds: ReadonlySet<string>): OktaUser[] {
  return users.filter((u) => !!u.id && (memberIds.has(u.id) || (isOktaLeaverStatus(u.status) && storedOktaIds.has(u.id))));
}

/** Above this share of the stored accounts, a removal is a wrong group or a bad response, not a cleanup. */
export const MAX_REMOVAL_SHARE = 0.5;

/** Stored Okta accounts this sync didn't write: out of scope now. Throws, before anything is written, past MAX_REMOVAL_SHARE. */
export function planOktaRemovals(storedOktaIds: ReadonlySet<string>, syncedOktaIds: Iterable<string>): string[] {
  const synced = new Set(syncedOktaIds);
  const out = [...storedOktaIds].filter((id) => !synced.has(id));
  if (out.length > storedOktaIds.size * MAX_REMOVAL_SHARE) {
    throw new Error(`Okta sync would remove ${out.length} of ${storedOktaIds.size} stored accounts: check the ${PEOPLE_GROUPS.join(" / ")} groups`);
  }
  return out;
}

/**
 * Okta identity pipeline (replaces HiBob): fetch users → persist raw → keep the people groups'
 * members (scopeOktaUsers) → normalize (bot titles skipped) → upsert employees (matched by okta_id,
 * then email — see persist.ts:upsertEmployees) → remove stored accounts now out of scope, unless they
 * carry history (persist.ts:removeOktaEmployees). Department comes straight from the Okta profile.
 * Every written row is stamped synced_at, so a kept out-of-scope row is the one left with an older
 * stamp. Fetchers are injected so tests/proofs run against fixtures.
 */
export async function syncOkta(
  supabase: SupabaseClient,
  fetcher: OktaFetcher = fetchOktaUsers,
  fetchGroup: OktaGroupFetcher = fetchOktaGroupMembers,
): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "okta");
  try {
    const raw = await fetcher();
    await saveRawPayload(supabase, "okta", runId, raw);
    if (!raw || !Array.isArray(raw.users)) throw new SchemaDriftError("okta", "missing `users` array");
    const [memberIds, stored] = await Promise.all([peopleGroupIds(fetchGroup), fetchStoredOktaIds(supabase)]);
    const syncedAt = new Date().toISOString();
    const employees = normalizeOkta({ users: scopeOktaUsers(raw.users, memberIds, stored) }).map((e) => ({ ...e, synced_at: syncedAt }));
    const removals = planOktaRemovals(stored, employees.map((e) => e.okta_id));
    const rowsWritten = await upsertEmployees(supabase, employees as unknown as Record<string, unknown>[]);
    const { removed, kept } = await removeOktaEmployees(supabase, removals);
    if (removed) console.log(`[okta] removed ${removed} stored account(s) outside ${PEOPLE_GROUPS.join(" / ")}`);
    if (kept.length) console.warn(`[okta] kept ${kept.length} out-of-scope account(s) with history (spend, keys, seats or a digest list): okta_id ${kept.join(", ")}`);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
