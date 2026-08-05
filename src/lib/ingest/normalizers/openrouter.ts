import type { SpendFact } from "@/lib/types";
import { SchemaDriftError } from "@/lib/ingest/types";
import type { DateWindow } from "@/lib/ingest/sources/anthropic";

/**
 * OpenRouter Analytics API — POST /api/v1/analytics/query with
 * dimensions ["user","model"] and day granularity. The day bucket arrives as
 * `date__day` (ISO datetime); the `user` dimension is enriched with the org
 * member's `user_email` (joins straight to employees). Spend metrics are USD
 * (1 OpenRouter credit = $1) and — documented quirk — numeric values may
 * arrive as strings, so everything is parsed defensively.
 */
export interface OpenRouterAnalyticsRow {
  date__day?: string;
  user?: string | null; // org-member Clerk id
  user_email?: string | null;
  model?: string | null;
  total_usage?: number | string | null;
  tokens_total?: number | string | null;
  request_count?: number | string | null;
}

export interface OpenRouterAnalyticsResponse {
  data: {
    data: OpenRouterAnalyticsRow[];
    metadata?: { row_count?: number; truncated?: boolean };
  };
}

/**
 * GET /api/v1/activity row — exact charged USD per (day, model, endpoint) for
 * the last 30 completed UTC days. `usage` is OpenRouter credits spent;
 * `byok_usage_inference` is spend on external BYOK keys (excluded — it would
 * double-count against the provider's own facts).
 */
export interface OpenRouterActivityRow {
  date: string;
  model?: string;
  usage?: number;
  byok_usage_inference?: number;
  requests?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
}

export interface OpenRouterActivityResponse {
  data: OpenRouterActivityRow[];
}

/** Metric values may be numbers or numeric strings; anything else is drift. */
function metric(value: number | string | null | undefined, field: string): number {
  if (value == null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new SchemaDriftError("openrouter", `non-numeric ${field}: ${JSON.stringify(value)}`);
  return n;
}

const factKey = (day: string, entityKey: string, model: string) => `${day}|${entityKey}|${model}`;

/**
 * Analytics rows → metered facts on the spend_facts grain. Rows are aggregated
 * by (day, member email, model) — lowercasing emails can merge vendor rows —
 * and clamped to [startDate, endDate): whether `time_range.end` is inclusive
 * isn't documented, so the window is enforced here rather than trusted.
 * Zero rows are kept when they carry tokens/requests (free-model usage is
 * real usage), dropped when fully empty.
 */
export function normalizeOpenRouterAnalytics(raw: OpenRouterAnalyticsResponse, window: DateWindow): SpendFact[] {
  const rows = raw?.data?.data;
  if (!Array.isArray(rows)) throw new SchemaDriftError("openrouter", "missing `data.data` array");

  const byKey = new Map<string, SpendFact>();
  for (const row of rows) {
    const day = typeof row.date__day === "string" ? row.date__day.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new SchemaDriftError("openrouter", `row without a date__day bucket: ${JSON.stringify(row.date__day)}`);
    }
    if (day < window.startDate || day >= window.endDate) continue;

    const email = (row.user_email ?? "").trim().toLowerCase();
    const entityKey = email || row.user || "unkeyed";
    const model = row.model ?? "";
    const costUsd = metric(row.total_usage, "total_usage");
    const tokens = metric(row.tokens_total, "tokens_total");
    const requests = metric(row.request_count, "request_count");
    if (costUsd === 0 && tokens === 0 && requests === 0) continue;

    const key = factKey(day, entityKey, model);
    const existing = byKey.get(key);
    if (existing) {
      existing.costUsd += costUsd;
      existing.tokens = (existing.tokens ?? 0) + tokens;
      existing.requests = (existing.requests ?? 0) + requests;
    } else {
      byKey.set(key, { source: "openrouter", day, costType: "metered", entityKey, costUsd, tokens, requests, model });
    }
  }
  return [...byKey.values()];
}

/**
 * Heal analytics↔activity drift: /activity is the authoritative charged USD
 * per day (but only covers the last 30 completed UTC days and can't split by
 * member), so any day where it reports MORE than the analytics rows sum to
 * gets the difference as an `unkeyed` fact — day totals stay exact even if
 * the beta analytics endpoint under-reports. Days /activity doesn't cover are
 * left alone; negative drift (activity < analytics) can't be subtracted from
 * per-person rows, so it's ignored.
 */
export function applyActivityRemainder(
  facts: SpendFact[],
  activity: OpenRouterActivityResponse,
  window: DateWindow,
): SpendFact[] {
  const rows = activity?.data;
  if (!Array.isArray(rows)) throw new SchemaDriftError("openrouter", "missing activity `data` array");

  const activityByDay = new Map<string, number>();
  for (const row of rows) {
    const day = typeof row.date === "string" ? row.date.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (day < window.startDate || day >= window.endDate) continue;
    activityByDay.set(day, (activityByDay.get(day) ?? 0) + metric(row.usage, "usage"));
  }

  const factsByDay = new Map<string, number>();
  for (const f of facts) factsByDay.set(f.day, (factsByDay.get(f.day) ?? 0) + f.costUsd);

  const out = facts.map((f) => ({ ...f }));
  for (const [day, activityUsd] of activityByDay) {
    const remainder = Math.round((activityUsd - (factsByDay.get(day) ?? 0)) * 100) / 100;
    if (remainder <= 0.01) continue;
    const unkeyed = out.find((f) => f.day === day && f.entityKey === "unkeyed" && f.model === "");
    if (unkeyed) unkeyed.costUsd += remainder;
    else out.push({ source: "openrouter", day, costType: "metered", entityKey: "unkeyed", costUsd: remainder, model: "" });
  }
  return out;
}
