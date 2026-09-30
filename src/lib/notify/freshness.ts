import { MONTHLY_SNAPSHOT_SOURCES } from "@/lib/explore/shape";
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
  usageThrough: string | null; // latest daily-usage fact day
}

/**
 * Per-source freshness from the latest sync run and the latest daily USAGE
 * day. Monthly-snapshot sources (Claude Team) are skipped: their usage is one
 * fact stamped on the 1st, so its "horizon" would flag every month as stale.
 */
export function sourceFreshness(runs: SyncRunRow[], usageHorizons: Record<string, string>): SourceFreshness[] {
  const latestRun = new Map<string, SyncRunRow>();
  for (const r of runs) {
    const cur = latestRun.get(r.source);
    if (!cur || r.startedAt > cur.startedAt) latestRun.set(r.source, r);
  }
  const sources = new Set<string>([...SYNCED_SOURCES, ...Object.keys(usageHorizons)]);
  const out: SourceFreshness[] = [];
  for (const source of sources) {
    if (MONTHLY_SNAPSHOT_SOURCES.has(source)) continue;
    out.push({
      source: source as Vendor,
      lastSyncFailed: (SYNCED_SOURCES as readonly string[]).includes(source) && latestRun.get(source)?.status === "failed",
      usageThrough: usageHorizons[source] ?? null,
    });
  }
  return out;
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
const lastDayOf = (p: DigestPeriod) => new Date(Date.parse(`${p.toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Caveats for ONE recipient: only sources in their (or their tree's) chart span. */
export function caveatsFor(args: {
  period: DigestPeriod;
  sourcesUsed: ReadonlySet<string>;
  freshness: SourceFreshness[];
  missingImports: MissingImport[];
}): string[] {
  const { period, sourcesUsed, freshness, missingImports } = args;
  const lastDay = lastDayOf(period);
  const out: string[] = [];
  for (const f of freshness) {
    if (!sourcesUsed.has(f.source)) continue;
    const behind = f.usageThrough !== null && f.usageThrough < lastDay;
    if (f.lastSyncFailed || behind) {
      out.push(`⚠ ${VENDOR_LABEL[f.source]} data may be incomplete${f.usageThrough ? ` (last updated ${dayLabel(f.usageThrough)})` : ""}`);
    }
  }
  if (period.cadence === "monthly") {
    const month = FULL[Number(period.key.slice(5, 7)) - 1];
    for (const m of missingImports) if (sourcesUsed.has(m.source)) out.push(`⚠ ${m.label} for ${month} not imported yet`);
  }
  return out;
}
