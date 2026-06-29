import type { ModelUsageFact } from "@/lib/types";
import { SchemaDriftError } from "@/lib/ingest/types";

/**
 * Cursor Analytics API — GET /analytics/by-user/models.
 *
 * `data` is keyed by user email; each value is an array of per-day rows, and
 * each row carries a `model_breakdown` mapping model name → { messages, users }.
 * At the by-user grain `users` is always 1 (it's that one user), so we keep only
 * `messages` — the additive metric. Distinct-user counts are derived downstream
 * by counting employees, never by summing this field across days.
 *
 * ⚠ Shape is per Cursor's docs but unverified against this tenant (same caveat
 * as the other Cursor fetchers); the normalizer throws SchemaDriftError on
 * anything unexpected so a drift fails loudly instead of writing garbage.
 */
export interface CursorModelBreakdownEntry {
  messages?: number;
  users?: number;
}
export interface CursorModelDailyRow {
  date?: string; // ISO date, e.g. "2026-06-09"
  model_breakdown?: Record<string, CursorModelBreakdownEntry>;
}
export interface CursorByUserModelsResponse {
  data?: Record<string, CursorModelDailyRow[]>;
  pagination?: {
    page?: number;
    pageSize?: number;
    totalUsers?: number;
    totalPages?: number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
}

export function normalizeCursorModels(raw: CursorByUserModelsResponse): ModelUsageFact[] {
  if (!raw || typeof raw.data !== "object" || raw.data === null || Array.isArray(raw.data)) {
    throw new SchemaDriftError("cursor_models", "missing `data` object keyed by email");
  }
  // Aggregate by (email, day, model). A single merged response won't collide,
  // but summing keeps us correct if the same user/day appears more than once.
  const messages = new Map<string, number>();
  const meta = new Map<string, { email: string; day: string; model: string }>();

  for (const [rawEmail, rows] of Object.entries(raw.data)) {
    const email = (rawEmail ?? "").toString().toLowerCase();
    if (!email || !Array.isArray(rows)) continue;
    for (const row of rows) {
      const day = typeof row.date === "string" ? row.date : "";
      const breakdown = row.model_breakdown;
      if (!day || !breakdown || typeof breakdown !== "object") continue;
      for (const [rawModel, stats] of Object.entries(breakdown)) {
        const model = (rawModel ?? "").toString() || "(unknown)";
        const n = Math.round(Number(stats?.messages ?? 0));
        if (!Number.isFinite(n) || n <= 0) continue;
        const key = `${email}|${day}|${model}`;
        messages.set(key, (messages.get(key) ?? 0) + n);
        if (!meta.has(key)) meta.set(key, { email, day, model });
      }
    }
  }

  return [...messages.entries()].map(([key, n]) => {
    const m = meta.get(key)!;
    return { day: m.day, entityKey: m.email, model: m.model, messages: n };
  });
}
