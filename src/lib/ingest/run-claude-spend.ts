import type { SupabaseClient } from "@supabase/supabase-js";
import { spreadClaudeSnapshots, type ClaudeSnapshotRow } from "./claude-spread";
import { replaceWindowFacts } from "./persist";

/** One person's line of a Claude Team paste (only non-zero rows are pasted in). */
export interface ClaudePasteRow {
  email: string;
  employeeId: string | null;
  mtdGbp: number;
  mtdUsd: number;
}

const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};

export function monthWindow(month: string): { startDate: string; endDate: string } {
  return { startDate: `${month}-01`, endDate: `${nextMonth(month)}-01` };
}

/** The months the nightly run re-spreads: last month and this month. */
export function recentClaudeMonths(now: Date): string[] {
  const cur = now.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  return [prev, cur];
}

type SnapshotRecord = { as_of: string; email: string; employee_id: string | null; mtd_usd: number | string };

/** Snapshot rows, paged past PostgREST's 1000-row cap (gotcha #1) on the table's key. */
async function readSnapshots(supabase: SupabaseClient, window?: { startDate: string; endDate: string }): Promise<SnapshotRecord[]> {
  const PAGE = 1000;
  const out: SnapshotRecord[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase.from("claude_spend_snapshots").select("as_of, email, employee_id, mtd_usd");
    if (window) query = query.gte("as_of", window.startDate).lt("as_of", window.endDate);
    const { data, error } = await query.order("as_of").order("email").range(from, from + PAGE - 1);
    if (error) throw new Error(`claude_spend_snapshots: ${error.message}`);
    out.push(...((data ?? []) as SnapshotRecord[]));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * Save one paste (every row dated `asOf`), then rebuild its month. Upsert first, then remove that
 * date's rows for people no longer in it — an empty paste changes nothing (gotcha #4).
 */
export async function saveClaudePaste(supabase: SupabaseClient, asOf: string, rows: ClaudePasteRow[], createdBy: string | null): Promise<number> {
  if (!rows.length) return 0;
  const { error } = await supabase.from("claude_spend_snapshots").upsert(
    rows.map((r) => ({
      as_of: asOf,
      email: r.email,
      employee_id: r.employeeId,
      mtd_gbp: r.mtdGbp,
      usd_per_gbp: r.mtdGbp > 0 ? Math.round((r.mtdUsd / r.mtdGbp) * 1e6) / 1e6 : null,
      mtd_usd: r.mtdUsd,
      created_by: createdBy,
    })),
    { onConflict: "as_of,email" },
  );
  if (error) throw new Error(`saveClaudePaste: ${error.message}`);
  const { data: existing, error: readErr } = await supabase.from("claude_spend_snapshots").select("email").eq("as_of", asOf);
  if (readErr) throw new Error(`saveClaudePaste(read): ${readErr.message}`);
  const keep = new Set(rows.map((r) => r.email));
  const stale = (existing ?? []).map((r) => r.email as string).filter((e) => !keep.has(e));
  if (stale.length) {
    const { error: delErr } = await supabase.from("claude_spend_snapshots").delete().eq("as_of", asOf).in("email", stale);
    if (delErr) throw new Error(`saveClaudePaste(prune): ${delErr.message}`);
  }
  return (await rebuildClaudeSpend(supabase, [asOf.slice(0, 7)])).rowsWritten;
}

/** Rebuild these months' Claude Team usage facts from their pastes. A month with no pastes is left alone. */
export async function rebuildClaudeSpend(supabase: SupabaseClient, months: string[]): Promise<{ rowsWritten: number }> {
  let rowsWritten = 0;
  for (const month of months) {
    const window = monthWindow(month);
    const rows = await readSnapshots(supabase, window);
    if (!rows.length) continue;
    const snaps: ClaudeSnapshotRow[] = rows.map((r) => ({ asOf: r.as_of, email: r.email, employeeId: r.employee_id, mtdUsd: Number(r.mtd_usd) }));
    // The month HAS pastes, so an empty spread means every increase was zero: prune is right.
    rowsWritten += await replaceWindowFacts(supabase, "claude_team", window, spreadClaudeSnapshots(snaps, month), { costType: "overage", pruneWhenEmpty: true });
  }
  return { rowsWritten };
}

/** Every month that has a paste (Data → Sync's one-off "rebuild all"). */
export async function claudeSnapshotMonths(supabase: SupabaseClient): Promise<string[]> {
  return [...new Set((await readSnapshots(supabase)).map((r) => r.as_of.slice(0, 7)))];
}
