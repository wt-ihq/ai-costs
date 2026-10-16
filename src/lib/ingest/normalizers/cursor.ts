import type { SpendFact } from "@/lib/types";
import { CURSOR_SERVICE_ACCOUNT } from "@/lib/pseudo-entities";
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
 * Cursor Admin API — filtered-usage-events → OVERAGE facts: on-demand spend only.
 *
 * Every event carries `chargedCents`, including usage the plan already includes ("Included in
 * Business", often `isChargeable: true` with a real charge): that is the token cost of included
 * usage, covered by the $40 seat, and `/teams/spend` reports `spendCents` as on-demand spend that
 * "excludes included usage". Counting it double-billed the seat (Jul–Oct 2026: thousands a month).
 * So only Usage-based events count; known non-billed kinds are skipped; a charged event of any
 * other kind throws (SchemaDriftError) rather than guess whether Cursor bills it.
 *
 * Aggregated to one fact per (entity, day, model). The entity is the user's email; service-account
 * usage (background agents, API) has no email — human events carry the string "null" as their
 * account id — so it lands under "cursor service account <id>" (a person-less key, see
 * pseudo-entities.ts) instead of being dropped. Each event self-dates via its epoch-ms `timestamp`,
 * so window boundaries never distort monthly totals. Cents are summed as integers, then divided.
 */
export interface CursorUsageEvent {
  timestamp?: string; // epoch ms, as a string
  userEmail?: string;
  serviceAccountId?: string | null; // "null" (a string) on human events
  model?: string;
  kind?: string;
  isChargeable?: boolean;
  chargedCents?: number; // model cost + Cursor Token Rate (priced even when included)
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


/** Kinds Cursor bills on top of the seat ("Usage-based", or USAGE_EVENT_KIND_USAGE_BASED). */
const isOnDemand = (kind: string) => /usage.?based/i.test(kind);
/** Kinds the plan covers, or Cursor doesn't bill: included usage, free models, the user's own API key. */
const isNotBilled = (kind: string) => /included|free|api.?key/i.test(kind);

const serviceAccountOf = (e: CursorUsageEvent): string | null => {
  const id = (e.serviceAccountId ?? "").toString().trim();
  return id && id.toLowerCase() !== "null" ? id : null;
};

export const normalizeCursorEvents: Normalizer<CursorEventsResponse> = (raw) => {
  if (!raw || !Array.isArray(raw.usageEvents)) {
    throw new SchemaDriftError("cursor", "missing `usageEvents` array");
  }
  const cents = new Map<string, number>();
  const meta = new Map<string, { entity: string; day: string; model: string }>();
  for (const e of raw.usageEvents) {
    const c = Math.round(Number(e.chargedCents ?? 0));
    if (!Number.isFinite(c) || c <= 0) continue; // nothing charged
    const kind = (e.kind ?? "").toString();
    if (!isOnDemand(kind)) {
      if (isNotBilled(kind)) continue;
      throw new SchemaDriftError("cursor", `charged usage event of unknown kind "${kind}"`);
    }
    const day = epochMsToDay(e.timestamp);
    if (!day) continue;
    const email = (e.userEmail ?? "").toString().trim().toLowerCase();
    const entity = email || `${CURSOR_SERVICE_ACCOUNT} ${serviceAccountOf(e) ?? "(unknown)"}`;
    const model = (e.model ?? "").toString() || "(unknown)";
    const key = `${entity}|${day}|${model}`;
    cents.set(key, (cents.get(key) ?? 0) + c);
    if (!meta.has(key)) meta.set(key, { entity, day, model });
  }
  return [...cents.entries()].map(([key, c]) => {
    const m = meta.get(key)!;
    return { source: "cursor", day: m.day, costType: "overage", entityKey: m.entity, costUsd: c / 100, model: m.model };
  });
};

/**
 * Cursor Admin API — GET /teams/members. The authoritative seat roster: every
 * member, including paid-but-idle ones that daily-usage-data (active-only)
 * misses. We emit one $40 seat per non-removed member for the given month,
 * keyed by email. The members endpoint is date-less (it's the *current*
 * roster), so the caller only applies it to the current month; historical
 * months keep their usage-derived seats. Upserts on (cursor, month, seat,
 * email) so it unions cleanly with any active-user seat for the same month.
 */
export interface CursorMember {
  id?: string;
  email?: string;
  name?: string;
  role?: string;
  isRemoved?: boolean;
}
export interface CursorMembersResponse {
  teamMembers?: CursorMember[];
}

/**
 * Teams-plan model signal from daily-usage-data: one (day, user, top-model) row
 * per active user/day, taken from `mostUsedModel`. Powers the Cursor Usage page
 * on the Teams plan (no Enterprise model-usage analytics). Deduped per
 * (day, email); rows without a model are skipped.
 */
export interface CursorTopModelRow {
  day: string;
  entityKey: string;
  model: string;
}

export function normalizeCursorTopModels(raw: CursorUsageResponse): CursorTopModelRow[] {
  if (!raw || !Array.isArray(raw.data)) {
    throw new SchemaDriftError("cursor", "missing `data` array");
  }
  const seen = new Set<string>();
  const out: CursorTopModelRow[] = [];
  for (const row of raw.data) {
    const email = (row.email ?? "").toString().toLowerCase();
    const day = typeof row.day === "string" ? row.day : "";
    const model = (row.mostUsedModel ?? "").toString();
    if (!email || !day || !model) continue;
    const key = `${day}|${email}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, entityKey: email, model });
  }
  return out;
}

export function normalizeCursorMembers(
  raw: CursorMembersResponse | CursorMember[],
  month: string,
): SpendFact[] {
  const list = Array.isArray(raw) ? raw : raw?.teamMembers;
  if (!Array.isArray(list)) {
    throw new SchemaDriftError("cursor", "members: expected an array (or { teamMembers: [] })");
  }
  const seen = new Set<string>();
  const facts: SpendFact[] = [];
  for (const m of list) {
    if (m.isRemoved) continue; // no longer holds a seat
    const email = (m.email ?? "").toString().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    facts.push({ source: "cursor", day: month, costType: "seat", entityKey: email, costUsd: CURSOR_SEAT_USD });
  }
  return facts;
}
