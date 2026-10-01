import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import type { DigestPeriod } from "./schedule";

export interface SyncRunRow {
  source: string;
  status: string;
  startedAt: string; // ISO timestamp
}

/** Spend sources refreshed by the daily API sync (their sync_runs.source equals the vendor). */
export const SYNCED_SOURCES: readonly Vendor[] = ["cursor", "anthropic", "openai", "vercel", "openrouter"];

export interface SourceFreshness {
  source: Vendor;
  lastSyncFailed: boolean;
  lastSuccessDay: string | null; // UTC day of the latest successful run in the loaded window
}

/**
 * Per-SYNCED-source state from the loaded sync runs. Manual sources (ChatGPT
 * Business, Claude Team imports) are never listed: their data is sparse by
 * nature, and a missing monthly import is reported by monthlyReadiness.
 */
export function sourceFreshness(runs: SyncRunRow[]): SourceFreshness[] {
  return SYNCED_SOURCES.map((source) => {
    let latest: SyncRunRow | undefined;
    let latestSuccess: SyncRunRow | undefined;
    for (const r of runs) {
      if (r.source !== source) continue;
      if (!latest || r.startedAt > latest.startedAt) latest = r;
      if (r.status === "success" && (!latestSuccess || r.startedAt > latestSuccess.startedAt)) latestSuccess = r;
    }
    return { source, lastSyncFailed: latest?.status === "failed", lastSuccessDay: latestSuccess?.startedAt.slice(0, 10) ?? null };
  });
}

/** False when not one spend source synced successfully today — daily/weekly sends are then skipped. */
export function anySyncSucceededToday(runs: SyncRunRow[], now: Date): boolean {
  const today = now.toISOString().slice(0, 10);
  return runs.some(
    (r) => (SYNCED_SOURCES as readonly string[]).includes(r.source) && r.status === "success" && r.startedAt.slice(0, 10) === today,
  );
}

export interface MissingImport {
  source: Vendor;
  label: string;
}

const MANUAL_COLUMNS = [
  { key: "chatgptSeats", source: "chatgpt_business", label: "ChatGPT Business seats" },
  { key: "chatgptCredits", source: "chatgpt_business", label: "ChatGPT Business credits" },
  { key: "claudeSpend", source: "claude_team", label: "Claude Team usage" },
  { key: "claudeSeats", source: "claude_team", label: "Claude Team seats" },
] as const;

const addMonths = (ym: string, k: number) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7);
};

/**
 * A month is ready when every manual-import column the org used in either of
 * the two months before it has data for it (a column nobody has used lately
 * can't block the recap forever).
 */
export function monthlyReadiness(rows: CoverageMonthRow[], month: string): { ready: boolean; missing: MissingImport[] } {
  const at = (m: string) => rows.find((r) => r.month === m);
  const cur = at(month);
  const p1 = at(addMonths(month, -1));
  const p2 = at(addMonths(month, -2));
  const missing = MANUAL_COLUMNS.filter((c) => (p1?.[c.key] || p2?.[c.key]) && !cur?.[c.key]).map(({ source, label }) => ({
    source: source as Vendor,
    label,
  }));
  return { ready: missing.length === 0, missing };
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${SHORT[Number(d.slice(5, 7)) - 1]}`;

/** Caveats for ONE recipient: only sources in their (or their tree's) chart span. */
export function caveatsFor(args: {
  period: DigestPeriod;
  sourcesUsed: ReadonlySet<string>;
  freshness: SourceFreshness[];
  missingImports: MissingImport[];
}): string[] {
  const { period, sourcesUsed, freshness, missingImports } = args;
  const out: string[] = [];
  for (const f of freshness) {
    if (!sourcesUsed.has(f.source)) continue;
    // Stale = latest run failed, or no successful run since the period ended (so it may not cover the last day).
    const stale = f.lastSyncFailed || f.lastSuccessDay === null || f.lastSuccessDay < period.toExclusive;
    if (stale) {
      out.push(`⚠ ${VENDOR_LABEL[f.source]} data may be incomplete${f.lastSuccessDay ? ` (last synced ${dayLabel(f.lastSuccessDay)})` : ""}`);
    }
  }
  if (period.cadence === "monthly") {
    const month = FULL[Number(period.key.slice(5, 7)) - 1];
    for (const m of missingImports) if (sourcesUsed.has(m.source)) out.push(`⚠ ${m.label} for ${month} not imported yet`);
  }
  return out;
}
