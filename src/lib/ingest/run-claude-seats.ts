import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOktaGroupMembers, type OktaGroupFetcher } from "@/lib/ingest/sources/okta";
import { finishSyncRun, loadEmployees, saveRawPayload, startSyncRun } from "@/lib/ingest/persist";
import { toSeatMembers } from "@/lib/ingest/run-chatgpt-seats";
import {
  computeClaudeSeatFacts, defaultSeatPrice, getSeatMonthEntry, replaceSeatMonth, resolveClaudeTiers,
  type ClaudeTier, type SeatMember, type TierInput,
} from "@/lib/ingest/seat-months";

/** The Okta group whose membership defines who holds a Claude seat. */
export const CLAUDE_OKTA_GROUP = "access-claude";

/**
 * Claude seats from Okta: refresh the CURRENT UTC month, tier per member from
 * seat_assignments (default standard). Same snapshot/authority/gotcha-#4
 * semantics as chatgpt_seats.
 */
export async function syncClaudeSeats(
  supabase: SupabaseClient,
  fetcher: OktaGroupFetcher = fetchOktaGroupMembers,
): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "claude_seats");
  try {
    const groupMembers = await fetcher(CLAUDE_OKTA_GROUP);
    await saveRawPayload(supabase, "claude_seats", runId, { group: CLAUDE_OKTA_GROUP, members: groupMembers });

    const month = new Date().toISOString().slice(0, 7) + "-01";
    const employees = await loadEmployees(supabase);
    const members = toSeatMembers(groupMembers.map((m) => m.email), employees);
    const tiers = await resolveClaudeTiers(supabase, month);
    const byTier: Record<ClaudeTier, SeatMember[]> = { standard: [], premium: [] };
    for (const m of members) byTier[m.employeeId ? tiers.get(m.employeeId) ?? "standard" : "standard"].push(m);

    const tierInputs: TierInput[] = [];
    for (const seatType of ["standard", "premium"] as const) {
      tierInputs.push({
        seatType,
        entry: await getSeatMonthEntry(supabase, month, "claude_team", seatType),
        members: byTier[seatType],
        defaultPriceUsd: await defaultSeatPrice(supabase, "claude_team", seatType),
      });
    }

    const rowsWritten = await replaceSeatMonth(supabase, month, computeClaudeSeatFacts(month, tierInputs), "claude_team");
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
