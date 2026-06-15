import type { SpendFact } from "@/lib/types";

export interface ParseRowError {
  line: number;
  message: string;
}

/** Parsers that produce spend facts (ChatGPT credits, Claude MTD spend). */
export interface FactParseResult {
  facts: SpendFact[];
  errors: ParseRowError[];
}

/** A per-user row from the Claude Team MTD spend dashboard. */
export interface ClaudeSpendRow {
  name: string;
  email: string;
  /** month-to-date spend in GBP, as billed (the dashboard reports £, not $) */
  mtdGbp: number;
  /** false when the spend-limit column reads "Unavailable" (no active seat) */
  available: boolean;
}

export interface ClaudeSpendResult {
  rows: ClaudeSpendRow[];
  errors: ParseRowError[];
}

/** A Claude Team seat from the roster CSV (priced per tier downstream). */
export interface SeatRow {
  email: string;
  fullName: string;
  role: string;
  status: string;
  /** normalized seat tier: premium | standard | unassigned */
  seatType: string;
}

export interface SeatParseResult {
  seats: SeatRow[];
  errors: ParseRowError[];
}

/** Parse "3.81K" / "16.1K" / "1.06K" / "1,234" / "0" to a number. */
export function parseHumanNumber(raw: string): number {
  const s = raw.trim().replace(/,/g, "");
  const m = /^([\d.]+)\s*([KMB])?$/i.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]);
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase()] ?? 1;
  // counts are whole numbers; round to shed float noise (16.1 * 1000 = 16100.00…2)
  return mult > 1 ? Math.round(n * mult) : n;
}
