import type { SpendFact, Vendor } from "@/lib/types";

export interface SeatAssignment {
  vendor: Vendor;
  email: string;
  seatType: string; // matches seat_prices.seat_type
}

/**
 * Turn seat assignments into monthly `seat` spend facts, priced from the
 * admin `seat_prices` config. Keyed to the 1st of the month so re-generating
 * upserts/replaces. Zero-priced tiers (e.g. Claude "unassigned") are still
 * emitted at $0 so the seat shows up in seat-hygiene views.
 */
export function buildSeatFacts(
  assignments: SeatAssignment[],
  prices: Record<string, number>, // `${vendor}:${seatType}` -> monthly USD
  monthIso: string,
): SpendFact[] {
  const day = monthIso.slice(0, 7) + "-01";
  return assignments.map((a) => ({
    source: a.vendor,
    day,
    costType: "seat",
    entityKey: a.email,
    costUsd: prices[`${a.vendor}:${a.seatType}`] ?? 0,
  }));
}
