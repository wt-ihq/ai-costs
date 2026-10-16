import type { SupabaseClient } from "@supabase/supabase-js";
import { CURSOR_SERVICE_ACCOUNT } from "@/lib/pseudo-entities";

/**
 * Independent reconciliation of our DERIVED Cursor overage (summed from
 * filtered-usage-events) against Cursor's AUTHORITATIVE per-cycle spend total
 * (POST /teams/spend). The Admin API docs say to reconcile event `chargedCents`
 * against `/teams/spend`, and our CLAUDE.md gotcha #2 wants a check against an
 * independent source — this is that check. Compares within the current billing
 * cycle (the grain `/teams/spend` reports).
 */
export interface CursorReconciliation {
  cycleStart: string; // YYYY-MM-DD
  /** Members' on-demand spend this cycle, from /teams/spend `spendCents` ("excludes included usage"). */
  cursorSpendUsd: number;
  /** `overallSpendCents`: on-demand plus plan-included usage (context only; null when not reported). */
  cursorOverallUsd: number | null;
  ourOverageUsd: number; // our people's overage (on-demand) facts since cycleStart
  /** Our service-account on-demand facts: not in Cursor's per-member figures, so shown apart. */
  serviceAccountUsd: number;
  deltaUsd: number; // ours − Cursor's
  deltaPct: number | null; // null when Cursor's total is 0
}

/** The comparison, pure: people's on-demand spend against Cursor's members' on-demand total. */
export function reconcileCursor(v: {
  cycleStart: string;
  spendCents: number;
  overallCents: number | null;
  facts: { entityKey: string; costUsd: number }[];
}): CursorReconciliation {
  const isService = (k: string) => k.startsWith(CURSOR_SERVICE_ACCOUNT);
  const sum = (xs: { costUsd: number }[]) => Math.round(xs.reduce((s, f) => s + f.costUsd, 0) * 100) / 100;
  const ourOverageUsd = sum(v.facts.filter((f) => !isService(f.entityKey)));
  const cursorSpendUsd = v.spendCents / 100;
  const deltaUsd = Math.round((ourOverageUsd - cursorSpendUsd) * 100) / 100;
  return {
    cycleStart: v.cycleStart,
    cursorSpendUsd,
    cursorOverallUsd: v.overallCents === null ? null : v.overallCents / 100,
    ourOverageUsd,
    serviceAccountUsd: sum(v.facts.filter((f) => isService(f.entityKey))),
    deltaUsd,
    deltaPct: cursorSpendUsd > 0 ? (deltaUsd / cursorSpendUsd) * 100 : null,
  };
}

const basicAuth = (key: string) => `Basic ${Buffer.from(`${key}:`).toString("base64")}`;

const dateOnly = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString().slice(0, 10);
  if (typeof v === "string") {
    const n = Number(v);
    const d = Number.isFinite(n) && v.trim() !== "" ? new Date(n) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
};

interface SpendPage {
  teamMemberSpend?: { spendCents?: number; overallSpendCents?: number }[];
  subscriptionCycleStart?: number | string;
  totalPages?: number;
}

/**
 * Returns null (so the UI just hides the panel) when the Cursor key is absent
 * or the API call fails — reconciliation is a best-effort sanity check, never a
 * hard dependency for the Data Health page.
 */
export async function getCursorReconciliation(supabase: SupabaseClient): Promise<CursorReconciliation | null> {
  const key = process.env.CURSOR_ADMIN_API_KEY;
  if (!key) return null;

  try {
    let cents = 0;
    let overall: number | null = null;
    let cycleStartRaw: number | string | undefined;
    let page = 1;
    let totalPages = 1;
    do {
      const res = await fetch("https://api.cursor.com/teams/spend", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basicAuth(key) },
        body: JSON.stringify({ page, pageSize: 100 }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as SpendPage;
      for (const m of json.teamMemberSpend ?? []) {
        cents += Number(m.spendCents ?? 0);
        if (m.overallSpendCents !== undefined) overall = (overall ?? 0) + Number(m.overallSpendCents);
      }
      cycleStartRaw = json.subscriptionCycleStart ?? cycleStartRaw;
      totalPages = Number(json.totalPages ?? 1);
      page++;
    } while (page <= totalPages);

    const cycleStart = dateOnly(cycleStartRaw);
    if (!cycleStart) return null;
    // Our derived overage since the cycle start (paginate the 1000-row cap).
    const PAGE = 1000;
    const facts: { entityKey: string; costUsd: number }[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("spend_facts")
        .select("entity_key, cost_usd")
        .eq("source", "cursor")
        .eq("cost_type", "overage")
        .gte("day", cycleStart)
        // Without ORDER BY, Postgres row order is unspecified per query, so
        // pages could overlap/skip past 1000 rows — corrupting the very number
        // this reconciliation exists to sanity-check.
        .order("day")
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) return null;
      if (!data || data.length === 0) break;
      for (const r of data as { entity_key: string; cost_usd: number }[]) facts.push({ entityKey: r.entity_key, costUsd: Number(r.cost_usd) });
      if (data.length < PAGE) break;
    }

    return reconcileCursor({ cycleStart, spendCents: cents, overallCents: overall, facts });
  } catch {
    return null;
  }
}
