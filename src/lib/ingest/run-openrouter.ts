import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchOpenRouterActivity,
  fetchOpenRouterAnalytics,
  fetchOpenRouterWorkspaces,
  type OpenRouterActivityFetcher,
  type OpenRouterAnalyticsFetcher,
  type OpenRouterWorkspacesFetcher,
} from "@/lib/ingest/sources/openrouter";
import {
  applyActivityRemainder,
  combineWorkspaceFacts,
  normalizeOpenRouterAnalytics,
  type OpenRouterWorkspace,
} from "@/lib/ingest/normalizers/openrouter";
import type { SpendFact } from "@/lib/types";
import type { DateWindow } from "@/lib/ingest/sources/anthropic";
import { attachEmployees, finishSyncRun, loadEmployees, replaceWindowFacts, saveRawPayload, startSyncRun } from "@/lib/ingest/persist";

export interface OpenRouterSyncResult {
  rowsWritten: number;
  unmatched: string[];
}

/**
 * Register every workspace seen (name refreshed, department never touched
 * after creation — admins correct it on the Data page) and return
 * workspace_id → department. New workspaces PREFILL department with their own
 * name: the org names workspaces after departments, so the default is right
 * and only exceptions need admin attention.
 */
async function registerWorkspaces(
  supabase: SupabaseClient,
  workspaces: OpenRouterWorkspace[],
): Promise<Map<string, string | null>> {
  // Bounded read: the table grows by workspaces, not days.
  const { data, error } = await supabase.from("openrouter_workspaces").select("workspace_id, department").limit(500);
  if (error) throw new Error(`registerWorkspaces read: ${error.message}`);
  const dept = new Map<string, string | null>((data ?? []).map((r) => [r.workspace_id as string, (r.department as string) ?? null]));

  const now = new Date().toISOString();
  const fresh = workspaces.filter((w) => !dept.has(w.id));
  const known = workspaces.filter((w) => dept.has(w.id));
  if (fresh.length) {
    const { error: insErr } = await supabase.from("openrouter_workspaces").upsert(
      fresh.map((w) => ({ workspace_id: w.id, name: w.name, department: w.name, updated_at: now })),
      { onConflict: "workspace_id" },
    );
    if (insErr) throw new Error(`registerWorkspaces insert: ${insErr.message}`);
    for (const w of fresh) dept.set(w.id, w.name);
  }
  if (known.length) {
    // Payload omits `department`, so ON CONFLICT leaves an assigned mapping intact.
    const { error: updErr } = await supabase.from("openrouter_workspaces").upsert(
      known.map((w) => ({ workspace_id: w.id, name: w.name, updated_at: now })),
      { onConflict: "workspace_id" },
    );
    if (updErr) throw new Error(`registerWorkspaces refresh: ${updErr.message}`);
  }
  return dept;
}

/**
 * OpenRouter → per-member metered facts. Queried PER WORKSPACE (the
 * analytics API caps dimensions at 2, but takes workspace as a filter), so a
 * fact carries the full (workspace × member × model × day) grain:
 * user-attributed rows resolve to employees; keyless rows (workspace-owned
 * API keys) become entity_key = workspace name attributed to the mapped
 * department. Falls back to one org-wide query (no workspace attribution) if
 * the workspace roster can't be fetched. /activity remains the drift check:
 * its authoritative day totals top up any analytics under-report as an
 * `unkeyed` fact.
 */
export async function syncOpenRouter(
  supabase: SupabaseClient,
  window: DateWindow,
  fetcher: OpenRouterAnalyticsFetcher = fetchOpenRouterAnalytics,
  activityFetcher: OpenRouterActivityFetcher = fetchOpenRouterActivity,
  workspacesFetcher: OpenRouterWorkspacesFetcher = fetchOpenRouterWorkspaces,
): Promise<OpenRouterSyncResult> {
  const runId = await startSyncRun(supabase, "openrouter");
  try {
    let facts: SpendFact[];
    try {
      const workspaces = await workspacesFetcher();
      const deptByWs = await registerWorkspaces(supabase, workspaces);
      const perWs = await Promise.all(
        workspaces.map(async (w) => ({
          name: w.name,
          department: deptByWs.get(w.id) ?? null,
          raw: await fetcher({ ...window, workspaceId: w.id }),
        })),
      );
      await saveRawPayload(supabase, "openrouter", runId, { workspaces, results: perWs.map((p) => p.raw) });
      facts = combineWorkspaceFacts(
        perWs.map((p) => ({ name: p.name, department: p.department, facts: normalizeOpenRouterAnalytics(p.raw, window) })),
      );
    } catch (err) {
      // Workspace path degraded (roster endpoint or a per-workspace query) —
      // org-wide totals are still correct, keyless usage just lands unkeyed.
      console.warn(`syncOpenRouter: workspace split unavailable, org-wide fallback: ${err instanceof Error ? err.message : String(err)}`);
      const raw = await fetcher(window);
      await saveRawPayload(supabase, "openrouter", runId, raw);
      facts = normalizeOpenRouterAnalytics(raw, window);
    }

    // Best-effort: the cross-check must not fail the sync when only the
    // secondary endpoint misbehaves — day totals just stay analytics-only.
    try {
      const activity = await activityFetcher();
      await saveRawPayload(supabase, "openrouter", runId, activity);
      facts = applyActivityRemainder(facts, activity, window);
    } catch (err) {
      console.warn(`syncOpenRouter: activity cross-check skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    const employees = await loadEmployees(supabase);
    const { facts: resolved } = attachEmployees(facts, employees);
    // Workspace-attributed facts aren't "unmatched" — they have a cost
    // center. Only entities with neither an employee nor a department are.
    const unmatched = [...new Set(resolved.filter((f) => !f.employeeId && !f.department).map((f) => f.entityKey))];

    // Snapshot-replace (upsert first, then prune stale keys); no-op on an
    // empty snapshot so a transient empty response can't wipe the window.
    // Scoped to metered: vendor-tagged recurring subscription facts share the
    // source and must survive the nightly replace.
    const rowsWritten = await replaceWindowFacts(supabase, "openrouter", window, resolved, { costType: "metered" });
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten });
    return { rowsWritten, unmatched };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
