import { monthlyReadiness } from "./freshness";
import { importsInUseSince, outstandingShort, readinessSyncSince, syncsOutstanding, weekReadiness } from "./readiness";
import { periodFor } from "./schedule";
import type { NotifyStore } from "./store";

/** Whether a weekly or monthly digest may go out, and what it's waiting for — the cron's rules, for one period. */
export async function periodReadiness(store: NotifyStore, cadence: "weekly" | "monthly", periodKey: string, now: Date): Promise<{ ready: boolean; missing: string[] }> {
  const period = periodFor(cadence, periodKey, now);
  const syncRuns = await store.recentSyncRuns(readinessSyncSince(now));
  if (cadence === "weekly") {
    const lastDay = new Date(Date.parse(`${period.toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const r = weekReadiness({ week: period, syncRuns, imports: await store.manualImports(importsInUseSince(lastDay)) });
    return { ready: r.ready, missing: r.outstanding.map(outstandingShort) };
  }
  const today = now.toISOString().slice(0, 10);
  const coverage = await store.importCoverage(today.slice(0, 7));
  const missing = [
    ...monthlyReadiness(coverage, periodKey).missing.map((m) => m.label),
    ...syncsOutstanding(syncRuns, `${today.slice(0, 7)}-01`).map(outstandingShort),
  ];
  return { ready: missing.length === 0, missing };
}

export const waitingText = (missing: string[]) => `Waiting for ${missing.join(" · ")}`;
