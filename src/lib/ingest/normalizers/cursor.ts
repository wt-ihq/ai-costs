import type { SpendFact } from "@/lib/types";
import { SchemaDriftError, type Normalizer } from "@/lib/ingest/types";

/**
 * Cursor Admin API — daily-usage-data. Confirmed shape: per-user/day rows with
 * activity metrics (lines, requests, usageBasedReqs) keyed by email — but NO
 * dollar cost field. So we model Cursor as a seat cost: one monthly $40 seat
 * (Cursor Teams price) per distinct user that appears in the window, keyed by
 * email. This endpoint has no $; the usage-based ("additional") spend comes
 * from filtered-usage-events via {@link normalizeCursorEvents}.
 */
export interface CursorUsageRow {
  day?: string; // ISO date, e.g. "2026-06-09"
  date?: number; // epoch ms (unused)
  email?: string;
  isActive?: boolean;
  mostUsedModel?: string;
  usageBasedReqs?: number;
}
export interface CursorUsageResponse {
  data: CursorUsageRow[];
}

const CURSOR_SEAT_USD = 40; // matches seat_prices default cursor:teams

export const normalizeCursor: Normalizer<CursorUsageResponse> = (raw) => {
  if (!raw || !Array.isArray(raw.data)) {
    throw new SchemaDriftError("cursor", "missing `data` array");
  }
  const seen = new Set<string>();
  const facts: SpendFact[] = [];
  for (const row of raw.data) {
    const email = (row.email ?? "").toString().toLowerCase();
    const day = typeof row.day === "string" ? row.day : "";
    if (!email || !day) continue;
    const month = day.slice(0, 7) + "-01"; // one seat per user per month
    const key = `${email}|${month}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      source: "cursor",
      day: month,
      costType: "seat",
      entityKey: email,
      costUsd: CURSOR_SEAT_USD,
      requests: row.usageBasedReqs ?? null,
    });
  }
  return facts;
};

/**
 * Cursor Admin API — filtered-usage-events. One row per billed usage event with
 * the actually-charged amount. We keep only chargeable events (chargedCents > 0
 * — seat-included usage is $0, so this never double-counts the seat fee) and
 * aggregate to one OVERAGE fact per (email, day, model). Each event self-dates
 * via its epoch-ms `timestamp`, so window boundaries never distort monthly
 * totals. Cents are summed as integers, then divided, to avoid float drift.
 */
export interface CursorUsageEvent {
  timestamp?: string; // epoch ms, as a string
  userEmail?: string;
  model?: string;
  kind?: string;
  isChargeable?: boolean;
  chargedCents?: number; // total charge (model cost + Cursor Token Rate)
}
export interface CursorEventsResponse {
  usageEvents?: CursorUsageEvent[];
  totalUsageEventsCount?: number;
  pagination?: { numPages?: number; currentPage?: number; pageSize?: number; hasNextPage?: boolean; hasPreviousPage?: boolean };
}

const epochMsToDay = (ms: string | number | undefined): string => {
  const n = typeof ms === "string" ? Number(ms) : ms;
  if (!n || !Number.isFinite(n)) return "";
  return new Date(n).toISOString().slice(0, 10);
};

export const normalizeCursorEvents: Normalizer<CursorEventsResponse> = (raw) => {
  if (!raw || !Array.isArray(raw.usageEvents)) {
    throw new SchemaDriftError("cursor", "missing `usageEvents` array");
  }
  const cents = new Map<string, number>();
  const meta = new Map<string, { email: string; day: string; model: string }>();
  for (const e of raw.usageEvents) {
    const c = Math.round(Number(e.chargedCents ?? 0));
    if (!Number.isFinite(c) || c <= 0) continue; // skip included/zero-charge usage
    const email = (e.userEmail ?? "").toString().toLowerCase();
    const day = epochMsToDay(e.timestamp);
    if (!email || !day) continue;
    const model = (e.model ?? "").toString() || "(unknown)";
    const key = `${email}|${day}|${model}`;
    cents.set(key, (cents.get(key) ?? 0) + c);
    if (!meta.has(key)) meta.set(key, { email, day, model });
  }
  return [...cents.entries()].map(([key, c]) => {
    const m = meta.get(key)!;
    return { source: "cursor", day: m.day, costType: "overage", entityKey: m.email, costUsd: c / 100, model: m.model };
  });
};
