import type { SupabaseClient } from "@supabase/supabase-js";

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
  cursorSpendUsd: number; // authoritative, from /teams/spend
  ourOverageUsd: number; // our overage facts since cycleStart
  deltaUsd: number; // ours − Cursor's
  deltaPct: number | null; // null when Cursor's total is 0
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
  teamMemberSpend?: { spendCents?: number }[];
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
      for (const m of json.teamMemberSpend ?? []) cents += Number(m.spendCents ?? 0);
      cycleStartRaw = json.subscriptionCycleStart ?? cycleStartRaw;
      totalPages = Number(json.totalPages ?? 1);
      page++;
    } while (page <= totalPages);

    const cycleStart = dateOnly(cycleStartRaw);
    if (!cycleStart) return null;
    const cursorSpendUsd = cents / 100;

    // Our derived overage since the cycle start (paginate the 1000-row cap).
    const PAGE = 1000;
    let ourOverageUsd = 0;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("spend_facts")
        .select("cost_usd")
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
      for (const r of data) ourOverageUsd += Number((r as { cost_usd: number }).cost_usd);
      if (data.length < PAGE) break;
    }

    const deltaUsd = ourOverageUsd - cursorSpendUsd;
    return {
      cycleStart,
      cursorSpendUsd,
      ourOverageUsd,
      deltaUsd,
      deltaPct: cursorSpendUsd > 0 ? (deltaUsd / cursorSpendUsd) * 100 : null,
    };
  } catch {
    return null;
  }
}
