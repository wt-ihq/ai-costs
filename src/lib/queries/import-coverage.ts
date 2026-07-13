import type { SupabaseClient } from "@supabase/supabase-js";
import type { CostType } from "@/lib/types";

/** One manual-source fact, trimmed to what the coverage table needs. */
export interface CoverageFactRow {
  day: string; // YYYY-MM-DD
  source: "chatgpt_business" | "claude_team";
  costType: CostType;
  costUsd: number;
}

/** One `imports` audit-log row. */
export interface CoverageImportRow {
  source: string;
  kind: string; // 'csv' | 'clipboard' | 'manual'
  dataAsOf: string; // YYYY-MM-DD
  createdAt: string; // ISO timestamp
  status: string;
}

export interface CoverageCell {
  totalUsd: number;
  lastImport: string | null; // YYYY-MM-DD of the latest successful import
}

export interface CoverageMonthRow {
  month: string; // YYYY-MM
  chatgptSeats: CoverageCell | null; // chatgpt_business seats (paste import)
  chatgptCredits: CoverageCell | null; // chatgpt_business overage (credits CSV)
  claudeSpend: CoverageCell | null; // claude_team overage
  claudeSeats: CoverageCell | null; // claude_team seats
}

export interface ImportCoverageScope {
  facts: CoverageFactRow[];
  imports: CoverageImportRow[];
}

type ColumnKey = "chatgptSeats" | "chatgptCredits" | "claudeSpend" | "claudeSeats";

const factColumn = (r: CoverageFactRow): ColumnKey =>
  r.source === "chatgpt_business"
    ? (r.costType === "seat" ? "chatgptSeats" : "chatgptCredits")
    : (r.costType === "seat" ? "claudeSeats" : "claudeSpend");

const importColumn = (r: CoverageImportRow): ColumnKey | null => {
  if (r.source === "chatgpt_business") return r.kind === "csv" ? "chatgptCredits" : "chatgptSeats";
  if (r.source === "claude_team") return r.kind === "csv" ? "claudeSeats" : "claudeSpend";
  return null;
};

/** Inclusive ascending list of YYYY-MM months. */
function monthSeq(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Pure: month × source coverage grid from facts + the imports audit log. */
export function buildImportCoverage(
  facts: CoverageFactRow[],
  importLog: CoverageImportRow[],
  nowMonth: string,
): CoverageMonthRow[] {
  if (!facts.length) return [];

  const totals = new Map<string, number>(); // `${month}:${col}` -> USD
  let earliest = facts[0].day.slice(0, 7);
  for (const f of facts) {
    const month = f.day.slice(0, 7);
    if (month < earliest) earliest = month;
    const key = `${month}:${factColumn(f)}`;
    totals.set(key, (totals.get(key) ?? 0) + f.costUsd);
  }

  const lastImports = new Map<string, string>(); // `${month}:${col}` -> YYYY-MM-DD
  for (const imp of importLog) {
    if (imp.status !== "success") continue;
    const col = importColumn(imp);
    if (!col) continue;
    const key = `${imp.dataAsOf.slice(0, 7)}:${col}`;
    const day = imp.createdAt.slice(0, 10);
    const prev = lastImports.get(key);
    if (!prev || day > prev) lastImports.set(key, day);
  }

  const cell = (month: string, col: ColumnKey): CoverageCell | null => {
    const total = totals.get(`${month}:${col}`);
    if (total === undefined) return null;
    return { totalUsd: Math.round(total * 100) / 100, lastImport: lastImports.get(`${month}:${col}`) ?? null };
  };

  return monthSeq(earliest, nowMonth)
    .reverse()
    .map((month) => ({
      month,
      chatgptSeats: cell(month, "chatgptSeats"),
      chatgptCredits: cell(month, "chatgptCredits"),
      claudeSpend: cell(month, "claudeSpend"),
      claudeSeats: cell(month, "claudeSeats"),
    }));
}

/** Fetch the manual-source facts + imports log (both paginated, gotcha #1). */
export async function getImportCoverageScope(supabase: SupabaseClient): Promise<ImportCoverageScope> {
  const PAGE = 1000;

  const facts: CoverageFactRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("spend_facts")
      .select("day, source, cost_type, cost_usd")
      .in("source", ["chatgpt_business", "claude_team"])
      .order("day")
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`getImportCoverageScope: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      facts.push({
        day: r.day as string,
        source: r.source as CoverageFactRow["source"],
        costType: r.cost_type as CostType,
        costUsd: Number(r.cost_usd),
      });
    }
    if (data.length < PAGE) break;
  }

  const imports: CoverageImportRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("imports")
      .select("source, kind, data_as_of, created_at, status")
      .order("created_at")
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`getImportCoverageScope (imports): ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      imports.push({
        source: r.source as string,
        kind: r.kind as string,
        dataAsOf: r.data_as_of as string,
        createdAt: r.created_at as string,
        status: r.status as string,
      });
    }
    if (data.length < PAGE) break;
  }

  return { facts, imports };
}
