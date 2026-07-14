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
  vendor: Vendor = "chatgpt_business",
  seatType = "chatgpt",
): Promise<SeatMonthEntry | null> {
  const { data, error } = await supabase
    .from("seat_month_entries")
    .select("seats, price_usd")
    .eq("vendor", vendor)
    .eq("seat_type", seatType)
    .eq("month", month)
    .limit(1);
  if (error) throw new Error(`getSeatMonthEntry: ${error.message}`);
  const row = data?.[0];
  return row ? { seats: Number(row.seats), priceUsd: Number(row.price_usd) } : null;
}

/**
 * Replace one month's seat facts for a given source (seat-scoped —
 * overage/credits are never touched). An empty fact set is the intentional
 * zero case: remove only leftover unassigned facts, surgically (gotcha #4:
 * no window wipe). The LIKE-prefix delete covers all of a source's
 * unassigned-seat keys (e.g. Claude's "unassigned seats (standard/premium)").
 */
export async function replaceSeatMonth(
  supabase: SupabaseClient,
  month: string, // YYYY-MM-01
  facts: ResolvedFact[],
  source: Vendor = "chatgpt_business",
): Promise<number> {
  if (facts.length === 0) {
    const { error } = await supabase
      .from("spend_facts")
      .delete()
      .eq("source", source)
      .eq("cost_type", "seat")
      .eq("day", month)
      .like("entity_key", `${UNASSIGNED_PREFIX}%`);
    if (error) throw new Error(`replaceSeatMonth: ${error.message}`);
    return 0;
  }
  // Seat facts are always stamped YYYY-MM-01, so a one-day window covers the month.
  const window = { startDate: month, endDate: month.slice(0, 8) + "02" };
  return replaceWindowFacts(supabase, source, window, facts, { costType: "seat" });
}

/** The month's member seat facts for a source (excludes unassigned-seat rows), paginated. */
export async function readSeatMonthMembers(
  supabase: SupabaseClient,
  source: Vendor,
  month: string, // YYYY-MM-01
): Promise<SeatMember[]> {
  const members: SeatMember[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("entity_key, employee_id")
      .eq("source", source)
      .eq("cost_type", "seat")
      .eq("day", month)
      .not("entity_key", "like", `${UNASSIGNED_PREFIX}%`)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`readSeatMonthMembers: ${error.message}`);
    for (const r of data ?? []) {
      members.push({ entityKey: r.entity_key as string, employeeId: (r.employee_id as string) ?? null });
    }
    if (!data || data.length < PAGE) break;
  }
  return members;
}

/** "vendor:seatType" → hardcoded floor when neither an entry nor seat_prices exists. */
export const SEAT_PRICE_FALLBACK: Record<string, number> = {
  "chatgpt_business:chatgpt": 25,
  "claude_team:standard": 19.05,
  "claude_team:premium": 95.25,
};

/**
 * The default per-seat price for a month WITHOUT its own entry: the latest
 * entry AT OR BEFORE the month — a later entry never re-prices an earlier
 * month; later no-entry months inherit the most recent earlier entry's
 * price. Falls through to seat_prices, then the constant.
 */
export async function defaultSeatPrice(
  supabase: SupabaseClient,
  vendor: Vendor,
  seatType: string,
  month: string, // YYYY-MM-01
): Promise<number> {
  const { data: latest, error: e1 } = await supabase
    .from("seat_month_entries")
    .select("price_usd")
    .eq("vendor", vendor)
    .eq("seat_type", seatType)
    .lte("month", month)
    .order("month", { ascending: false })
    .limit(1);
  if (e1) throw new Error(`defaultSeatPrice entries: ${e1.message}`);
  if (latest?.[0]) return Number(latest[0].price_usd);

  const { data: priced, error: e2 } = await supabase
    .from("seat_prices")
    .select("monthly_price_usd")
    .eq("vendor", vendor)
    .eq("seat_type", seatType)
    .limit(1);
  if (e2) throw new Error(`defaultSeatPrice seat_prices: ${e2.message}`);
  if (priced?.[0]) return Number(priced[0].monthly_price_usd);

  return SEAT_PRICE_FALLBACK[`${vendor}:${seatType}`] ?? 0;
}

/**
 * Rebuild a month's ChatGPT seat facts after a manual-entry change. Members
 * come from the month's existing member seat facts (i.e. the latest paste);
 * the paste commit itself passes fresh members directly instead.
 */
export async function rebuildChatGptSeatMonth(
  supabase: SupabaseClient,
  month: string, // YYYY-MM-01
): Promise<number> {
  const entry = await getSeatMonthEntry(supabase, month);
  const members = await readSeatMonthMembers(supabase, "chatgpt_business", month);
  const defaultPriceUsd = await defaultSeatPrice(supabase, "chatgpt_business", "chatgpt", month);

  return replaceSeatMonth(supabase, month, computeSeatFacts(month, entry, members, defaultPriceUsd));
}

/**
 * Rebuild a Claude month after an entry change or roster (tier) upload:
 * members from the month's stored seat facts, tiers re-resolved, entries
 * authoritative per tier.
 */
export async function rebuildClaudeSeatMonth(supabase: SupabaseClient, month: string): Promise<number> {
  const members = await readSeatMonthMembers(supabase, "claude_team", month);
  const tiers = await resolveClaudeTiers(supabase, month);
  const byTier: Record<ClaudeTier, SeatMember[]> = { standard: [], premium: [] };
  for (const m of members) byTier[m.employeeId ? tiers.get(m.employeeId) ?? "standard" : "standard"].push(m);

  const tierInputs: TierInput[] = [];
  for (const seatType of ["standard", "premium"] as const) {
    tierInputs.push({
      seatType,
      entry: await getSeatMonthEntry(supabase, month, "claude_team", seatType),
      members: byTier[seatType],
      defaultPriceUsd: await defaultSeatPrice(supabase, "claude_team", seatType, month),
    });
  }
  return replaceSeatMonth(supabase, month, computeClaudeSeatFacts(month, tierInputs), "claude_team");
}

/** premium only when the winning assignment says so; anything else is standard. */
export function pickTier(assignments: { seatType: string; periodStart: string }[], month: string): ClaudeTier {
  if (assignments.length === 0) return "standard";
  const atOrBefore = assignments.filter((x) => x.periodStart <= month);
  const pool = atOrBefore.length ? atOrBefore : assignments;
  const winner = pool.reduce((best, x) => (x.periodStart > best.periodStart ? x : best));
  return winner.seatType === "premium" ? "premium" : "standard";
}

/** employee_id → tier for a month, from seat_assignments (paginated, gotcha #1). */
export async function resolveClaudeTiers(supabase: SupabaseClient, month: string): Promise<Map<string, ClaudeTier>> {
  const byEmployee = new Map<string, { seatType: string; periodStart: string }[]>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("seat_assignments")
      .select("employee_id, seat_type, period_start")
      .eq("vendor", "claude_team")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`resolveClaudeTiers: ${error.message}`);
    for (const r of data ?? []) {
      if (!r.employee_id) continue;
      const list = byEmployee.get(r.employee_id as string) ?? [];
      list.push({ seatType: r.seat_type as string, periodStart: r.period_start as string });
      byEmployee.set(r.employee_id as string, list);
    }
    if (!data || data.length < PAGE) break;
  }
  return new Map([...byEmployee.entries()].map(([id, list]) => [id, pickTier(list, month)]));
}
