import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOktaGroupMembers, type OktaGroupFetcher } from "@/lib/ingest/sources/okta";
import { finishSyncRun, loadEmployees, saveRawPayload, startSyncRun } from "@/lib/ingest/persist";
import { matchIdentity } from "@/lib/ingest/identity";
import {
  computeSeatFacts,
  defaultSeatPrice,
  getSeatMonthEntry,
  replaceSeatMonth,
  type SeatMember,
} from "@/lib/ingest/seat-months";

/** The Okta group whose membership defines who holds a ChatGPT seat. */
export const CHATGPT_OKTA_GROUP = "access-chatgpt";

/** Group emails → deduped, employee-resolved SeatMembers. Pure. */
export function toSeatMembers(
  emails: string[],
  employees: { id: string; email: string }[],
): SeatMember[] {
  const seen = new Set<string>();
  const members: SeatMember[] = [];
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    members.push({ entityKey: email, employeeId: matchIdentity(email, employees).employeeId });
  }
  return members;
}

/**
 * ChatGPT seats from Okta: refresh the CURRENT UTC month's seat facts from the
 * access-chatgpt group. The month's last daily run (e.g. Jul 31, 06:00 UTC) is
 * naturally its final snapshot; past months are never touched. A manual
 * seat_month_entries row stays authoritative — computeSeatFacts distributes
 * its total across these members. Fetcher failures (incl. group not found)
 * throw and land on Data Health; an empty member list can't wipe the month
 * (replaceSeatMonth's empty path only removes the unassigned fact, gotcha #4).
 */
export async function syncChatGptSeats(
  supabase: SupabaseClient,
  fetcher: OktaGroupFetcher = fetchOktaGroupMembers,
): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "chatgpt_seats");
  try {
    const groupMembers = await fetcher(CHATGPT_OKTA_GROUP);
    await saveRawPayload(supabase, "chatgpt_seats", runId, { group: CHATGPT_OKTA_GROUP, members: groupMembers });

    const month = new Date().toISOString().slice(0, 7) + "-01"; // current UTC month
    const employees = await loadEmployees(supabase);
    const members = toSeatMembers(groupMembers.map((m) => m.email), employees);

    const entry = await getSeatMonthEntry(supabase, month);
    const defaultPrice = await defaultSeatPrice(supabase, "chatgpt_business", "chatgpt", month);

    const rowsWritten = await replaceSeatMonth(supabase, month, computeSeatFacts(month, entry, members, defaultPrice));
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
