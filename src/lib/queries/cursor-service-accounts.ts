import type { SupabaseClient } from "@supabase/supabase-js";
import type { CursorServiceAccountRow } from "@/components/cursor-service-accounts";
import { loadServiceAccounts, serviceAccountIdOf } from "@/lib/ingest/cursor-service-accounts";
import { CURSOR_SERVICE_ACCOUNT } from "@/lib/pseudo-entities";

/** Data → Tools: every Cursor service account with its name, team and last-30-days spend, biggest first. */
export async function loadCursorServiceAccountRows(supabase: SupabaseClient, now = new Date()): Promise<CursorServiceAccountRow[]> {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [settings, spend] = await Promise.all([loadServiceAccounts(supabase), last30(supabase, since)]);
  const ids = new Set([...settings.keys(), ...spend.keys()]);
  return [...ids]
    .map((id) => ({ accountId: id, label: settings.get(id)?.label ?? null, department: settings.get(id)?.department ?? null, last30Usd: Math.round((spend.get(id) ?? 0) * 100) / 100 }))
    .sort((a, b) => b.last30Usd - a.last30Usd || a.accountId.localeCompare(b.accountId));
}

/** Service-account spend since `since`, by account id — paged past the 1000-row cap (gotcha #1). */
async function last30(supabase: SupabaseClient, since: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("entity_key, cost_usd")
      .eq("source", "cursor")
      .like("entity_key", `${CURSOR_SERVICE_ACCOUNT} %`)
      .gte("day", since)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`cursor service-account spend: ${error.message}`);
    for (const r of (data ?? []) as { entity_key: string; cost_usd: number | string }[]) {
      const id = serviceAccountIdOf(r.entity_key);
      if (id) out.set(id, (out.get(id) ?? 0) + Number(r.cost_usd));
    }
    if (!data || data.length < PAGE) return out;
  }
}
