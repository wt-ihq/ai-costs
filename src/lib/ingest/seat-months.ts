import type { SupabaseClient } from "@supabase/supabase-js";
import type { Vendor } from "@/lib/types";
import { replaceWindowFacts, type ResolvedFact } from "@/lib/ingest/persist";

/** Entity key for seats paid for but not attributed to a pasted member. */
export const UNASSIGNED_SEATS_KEY = "unassigned seats";

/** All unassigned-seat keys start with this prefix. */
export const UNASSIGNED_PREFIX = "unassigned seats";

export type ClaudeTier = "standard" | "premium";

export const CLAUDE_UNASSIGNED_KEY: Record<ClaudeTier, string> = {
  standard: "unassigned seats (standard)",
  premium: "unassigned seats (premium)",
};

export interface SeatFactOpts {
  source: Vendor;
  unassignedKey: string;
}

export interface SeatMonthEntry {
  seats: number;
  priceUsd: number;
}

export interface SeatMember {
  entityKey: string; // lowercased email (Okta-sourced months) or legacy normalized display name (historical paste months)
  employeeId: string | null;
}

/**
 * The full seat-fact set for one month. When a manual entry exists it is
 * AUTHORITATIVE: the facts always sum to exactly seats × price (in cents).
 * Members (from the paste) only distribute attribution:
 *   - no entry            → members × default price (legacy behavior)
 *   - entry, no members   → one "unassigned seats" fact for the whole total
 *   - entry, M ≤ seats    → members at price, remainder unassigned
 *   - entry, M > seats    → total split evenly across members, cent-exact
 *                           (remainder lands on the last member in entityKey order)
 * Returns [] only for a zero-total entry with no members — the caller must
 * then remove any stale unassigned fact surgically (never a window wipe).
 */
export function computeSeatFacts(
  month: string,
  entry: SeatMonthEntry | null,
  members: SeatMember[],
  defaultPriceUsd: number,
  opts?: Partial<SeatFactOpts>,
): ResolvedFact[] {
  const { source = "chatgpt_business", unassignedKey = UNASSIGNED_SEATS_KEY } = opts ?? {};

  const fact = (entityKey: string, costUsd: number, employeeId: string | null): ResolvedFact => ({
    source,
    day: month,
    costType: "seat",
    entityKey,
    costUsd,
    employeeId,
  });

  if (!entry) return members.map((m) => fact(m.entityKey, defaultPriceUsd, m.employeeId));

  const totalCents = Math.round(entry.seats * entry.priceUsd * 100);
  const count = members.length;

  if (count === 0) return totalCents > 0 ? [fact(unassignedKey, totalCents / 100, null)] : [];

  if (count <= entry.seats) {
    const memberCents = Math.round(entry.priceUsd * 100);
    const facts = members.map((m) => fact(m.entityKey, memberCents / 100, m.employeeId));
    const remainderCents = totalCents - memberCents * count;
    if (remainderCents > 0) facts.push(fact(unassignedKey, remainderCents / 100, null));
    return facts;
  }

  // More members than seats: manual count wins — split the total evenly.
  // Sort so the remainder placement is deterministic regardless of input order
  // (the paste path passes paste order; rebuildChatGptSeatMonth reads by uuid id).
  const ordered = [...members].sort((a, b) => a.entityKey.localeCompare(b.entityKey));
  const perCents = Math.floor(totalCents / count);
  return ordered.map((m, i) => {
    const cents = i === count - 1 ? totalCents - perCents * (count - 1) : perCents;
    return fact(m.entityKey, cents / 100, m.employeeId);
  });
}

export interface TierInput {
  seatType: ClaudeTier;
  entry: SeatMonthEntry | null;
  members: SeatMember[];
  defaultPriceUsd: number;
}

/** Claude month = the single-tier computation per tier, concatenated. */
export function computeClaudeSeatFacts(month: string, tiers: TierInput[]): ResolvedFact[] {
  return tiers.flatMap((t) =>
    computeSeatFacts(month, t.entry, t.members, t.defaultPriceUsd, {
      source: "claude_team",
      unassignedKey: CLAUDE_UNASSIGNED_KEY[t.seatType],
    }),
  );
}

/** The month's manual entry, if one has been saved. Single row — no pagination needed. */
export async function getSeatMonthEntry(
  supabase: SupabaseClient,
  month: string, // YYYY-MM-01
): Promise<SeatMonthEntry | null> {
  const { data, error } = await supabase
    .from("seat_month_entries")
    .select("seats, price_usd")
    .eq("vendor", "chatgpt_business")
    .eq("month", month)
    .limit(1);
  if (error) throw new Error(`getSeatMonthEntry: ${error.message}`);
  const row = data?.[0];
  return row ? { seats: Number(row.seats), priceUsd: Number(row.price_usd) } : null;
}

/**
 * Replace one month's ChatGPT seat facts (seat-scoped — overage/credits are
 * never touched). An empty fact set is the intentional zero case: remove only
 * a leftover unassigned fact, surgically (gotcha #4: no window wipe).
 */
export async function replaceSeatMonth(
  supabase: SupabaseClient,
  month: string, // YYYY-MM-01
  facts: ResolvedFact[],
): Promise<number> {
  if (facts.length === 0) {
    const { error } = await supabase
      .from("spend_facts")
      .delete()
      .eq("source", "chatgpt_business")
      .eq("cost_type", "seat")
      .eq("day", month)
      .eq("entity_key", UNASSIGNED_SEATS_KEY);
    if (error) throw new Error(`replaceSeatMonth: ${error.message}`);
    return 0;
  }
  // Seat facts are always stamped YYYY-MM-01, so a one-day window covers the month.
  const window = { startDate: month, endDate: month.slice(0, 8) + "02" };
  return replaceWindowFacts(supabase, "chatgpt_business", window, facts, { costType: "seat" });
}

/**
 * Rebuild a month's seat facts after a manual-entry change. Members come from
 * the month's existing member seat facts (i.e. the latest paste); the paste
 * commit itself passes fresh members directly instead.
 */
export async function rebuildChatGptSeatMonth(
  supabase: SupabaseClient,
  month: string, // YYYY-MM-01
  defaultPriceUsd: number,
): Promise<number> {
  const entry = await getSeatMonthEntry(supabase, month);

  const members: SeatMember[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("entity_key, employee_id")
      .eq("source", "chatgpt_business")
      .eq("cost_type", "seat")
      .eq("day", month)
      .neq("entity_key", UNASSIGNED_SEATS_KEY)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`rebuildChatGptSeatMonth: ${error.message}`);
    for (const r of data ?? []) {
      members.push({ entityKey: r.entity_key as string, employeeId: (r.employee_id as string) ?? null });
    }
    if (!data || data.length < PAGE) break;
  }

  return replaceSeatMonth(supabase, month, computeSeatFacts(month, entry, members, defaultPriceUsd));
}
