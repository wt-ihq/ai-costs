import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchVercelCharges, type VercelFetcher } from "@/lib/ingest/sources/vercel";
import { normalizeVercel, type FocusCharge } from "@/lib/ingest/normalizers/vercel";
import type { DateWindow } from "@/lib/ingest/sources/anthropic";
import { finishSyncRun, replaceWindowFacts, saveRawPayload, startSyncRun, type ResolvedFact } from "@/lib/ingest/persist";

/** Register every project seen in the charges; refresh names, never touch departments. */
async function upsertVercelProjects(supabase: SupabaseClient, charges: FocusCharge[]): Promise<void> {
  const byId = new Map<string, string>();
  for (const c of charges) {
    const id = c.Tags?.ProjectId;
    if (id) byId.set(id, c.Tags?.ProjectName ?? id);
  }
  if (byId.size === 0) return;
  const rows = [...byId.entries()].map(([project_id, project_name]) => ({
    project_id, project_name, updated_at: new Date().toISOString(),
  }));
  // Payload omits `department`, so ON CONFLICT leaves an assigned mapping intact.
  const { error } = await supabase.from("vercel_projects").upsert(rows, { onConflict: "project_id" });
  if (error) throw new Error(`upsertVercelProjects: ${error.message}`);
}

/** project_name → department (assigned rows only). Bounded read — the table grows by projects, not days. */
async function loadVercelDepartments(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("vercel_projects").select("project_name, department").limit(200);
  if (error) throw new Error(`loadVercelDepartments: ${error.message}`);
  return new Map((data ?? []).filter((r) => r.department).map((r) => [r.project_name as string, r.department as string]));
}

/**
 * Vercel FOCUS billing → spend facts, month-to-date snapshot like the other
 * metered sources. Department attribution is eventually consistent: a mapping
 * assigned mid-sync may be overwritten for the current month by this run's
 * stale map read, and heals on the next run (assignments re-attach history
 * in place; syncs re-derive the current month from the committed map).
 */
/**
 * Days of charges kept in the nightly raw payload. The window is month-to-date,
 * so a full payload would re-store the whole month every night (that insert
 * was in flight when the DB crash-restarted at 06:02 UTC on 20–26 Oct 2026).
 * Each day still lands in a week of consecutive payloads for replay.
 */
export const RAW_PAYLOAD_DAYS = 7;

/** The window's last RAW_PAYLOAD_DAYS days (exclusive end), clamped to the window start. */
export function rawPayloadWindow(window: DateWindow): DateWindow {
  const end = new Date(`${window.endDate}T00:00:00Z`);
  const tail = new Date(end.getTime() - RAW_PAYLOAD_DAYS * 86_400_000).toISOString().slice(0, 10);
  return { startDate: tail > window.startDate ? tail : window.startDate, endDate: window.endDate };
}

export async function syncVercel(
  supabase: SupabaseClient,
  window: DateWindow,
  fetcher: VercelFetcher = fetchVercelCharges,
): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "vercel");
  try {
    const charges = await fetcher(window);
    const kept = rawPayloadWindow(window);
    await saveRawPayload(supabase, "vercel", runId, {
      window: kept,
      charges: charges.filter((c) => {
        const day = c.ChargePeriodStart?.slice(0, 10) ?? "";
        return day >= kept.startDate && day < kept.endDate;
      }),
    });
    await upsertVercelProjects(supabase, charges);
    const departments = await loadVercelDepartments(supabase);
    const facts: ResolvedFact[] = normalizeVercel(charges).map((f) => ({
      ...f,
      employeeId: null,
      department: departments.get(f.entityKey) ?? null,
    }));
    // Scoped to metered: vendor-tagged recurring subscription facts share the
    // source and must survive the nightly replace.
    const rowsWritten = await replaceWindowFacts(supabase, "vercel", window, facts, { costType: "metered" });
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
