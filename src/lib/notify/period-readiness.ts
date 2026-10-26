import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import { monthlyReadiness, type SyncRunRow } from "./freshness";
import { importsInUseSince, outstandingShort, readinessSyncSince, syncsOutstanding, weekReadiness, type ManualImportRow } from "./readiness";
import { periodFor } from "./schedule";
import type { NotifyStore } from "./store";

/** Reads shared across several periodReadiness calls in one page load (each is a paged table read). */
export interface ReadinessReads {
  syncRuns?: Promise<SyncRunRow[]>;
  coverage?: Promise<CoverageMonthRow[]>;
  imports?: Map<string, Promise<ManualImportRow[]>>;
}

/** Whether a weekly or monthly digest may go out, and what it's waiting for — the cron's rules, for one period. */
export async function periodReadiness(
  store: NotifyStore,
  cadence: "weekly" | "monthly",
  periodKey: string,
  now: Date,
  reads: ReadinessReads = {},
): Promise<{ ready: boolean; missing: string[] }> {
  const period = periodFor(cadence, periodKey, now);
  const syncRuns = await (reads.syncRuns ??= store.recentSyncRuns(readinessSyncSince(now)));
  if (cadence === "weekly") {
    const lastDay = new Date(Date.parse(`${period.toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const since = importsInUseSince(lastDay);
    const importsBySince = (reads.imports ??= new Map());
    let imports = importsBySince.get(since);
    if (!imports) importsBySince.set(since, (imports = store.manualImports(since)));
    const r = weekReadiness({ week: period, syncRuns, imports: await imports });
    return { ready: r.ready, missing: r.outstanding.map(outstandingShort) };
  }
  const today = now.toISOString().slice(0, 10);
  const coverage = await (reads.coverage ??= store.importCoverage(today.slice(0, 7)));
  const missing = [
    ...monthlyReadiness(coverage, periodKey).missing.map((m) => m.label),
    ...syncsOutstanding(syncRuns, `${today.slice(0, 7)}-01`).map(outstandingShort),
  ];
  return { ready: missing.length === 0, missing };
}

export const waitingText = (missing: string[]) => `Waiting for ${missing.join(" · ")}`;
