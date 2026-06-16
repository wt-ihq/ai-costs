import type { SpendFact } from "@/lib/types";
import { SchemaDriftError, type Normalizer } from "@/lib/ingest/types";

/**
 * Cursor Admin API — daily-usage-data. Confirmed shape: per-user/day rows with
 * activity metrics (lines, requests, usageBasedReqs) keyed by email — but NO
 * dollar cost field. So we model Cursor as a seat cost: one monthly $40 seat
 * (Cursor Teams price) per distinct user that appears in the window, keyed by
 * email. Usage-based overage has no $ in this endpoint (a known v1 limitation;
 * usageBasedReqs is retained as an activity signal).
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
