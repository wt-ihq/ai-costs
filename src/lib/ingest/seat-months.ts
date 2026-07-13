import type { ResolvedFact } from "@/lib/ingest/persist";

/** Entity key for seats paid for but not attributed to a pasted member. */
export const UNASSIGNED_SEATS_KEY = "unassigned seats";

export interface SeatMonthEntry {
  seats: number;
  priceUsd: number;
}

export interface SeatMember {
  entityKey: string; // normalized display name (paste) — matches existing seat-fact keys
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
 *                           (last member absorbs the rounding remainder)
 * Returns [] only for a zero-total entry with no members — the caller must
 * then remove any stale unassigned fact surgically (never a window wipe).
 */
export function computeSeatFacts(
  month: string,
  entry: SeatMonthEntry | null,
  members: SeatMember[],
  defaultPriceUsd: number,
): ResolvedFact[] {
  const fact = (entityKey: string, costUsd: number, employeeId: string | null): ResolvedFact => ({
    source: "chatgpt_business",
    day: month,
    costType: "seat",
    entityKey,
    costUsd,
    employeeId,
  });

  if (!entry) return members.map((m) => fact(m.entityKey, defaultPriceUsd, m.employeeId));

  const totalCents = Math.round(entry.seats * entry.priceUsd * 100);
  const count = members.length;

  if (count === 0) return totalCents > 0 ? [fact(UNASSIGNED_SEATS_KEY, totalCents / 100, null)] : [];

  if (count <= entry.seats) {
    const memberCents = Math.round(entry.priceUsd * 100);
    const facts = members.map((m) => fact(m.entityKey, memberCents / 100, m.employeeId));
    const remainderCents = totalCents - memberCents * count;
    if (remainderCents > 0) facts.push(fact(UNASSIGNED_SEATS_KEY, remainderCents / 100, null));
    return facts;
  }

  // More members than seats: manual count wins — split the total evenly.
  const perCents = Math.floor(totalCents / count);
  return members.map((m, i) => {
    const cents = i === count - 1 ? totalCents - perCents * (count - 1) : perCents;
    return fact(m.entityKey, cents / 100, m.employeeId);
  });
}
