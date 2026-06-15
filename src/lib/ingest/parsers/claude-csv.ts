import type { SpendFact } from "@/lib/types";

export interface ParseRowError {
  line: number;
  message: string;
}

export interface ParseResult {
  facts: SpendFact[];
  errors: ParseRowError[];
}

/**
 * Claude Team CSV spend export (per-user, per-model). Emitted as cost_type
 * "overage" — the seat cost is generated separately from seat_assignments.
 *
 * All-or-nothing per file: callers must reject the whole import if
 * `errors` is non-empty (spec §6, §8). Column names are validated against a
 * real export in week 1 (spec §11) and are intentionally lenient here.
 */
export function parseClaudeTeamCsv(csv: string, asOf: string): ParseResult {
  const facts: SpendFact[] = [];
  const errors: ParseRowError[] = [];

  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { facts, errors: [{ line: 0, message: "empty or header-only CSV" }] };
  }

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const emailCol = col("email");
  const modelCol = col("model");
  const costCol = col("cost_usd") >= 0 ? col("cost_usd") : col("spend_usd");

  if (emailCol < 0 || costCol < 0) {
    return {
      facts,
      errors: [{ line: 0, message: "missing required columns: email, cost_usd" }],
    };
  }

  lines.slice(1).forEach((line, i) => {
    const lineNo = i + 2;
    const cells = line.split(",").map((c) => c.trim());
    const email = cells[emailCol];
    const cost = Number(cells[costCol]);

    if (!email) {
      errors.push({ line: lineNo, message: "missing email" });
      return;
    }
    if (!Number.isFinite(cost)) {
      errors.push({ line: lineNo, message: `non-numeric cost: "${cells[costCol]}"` });
      return;
    }
    if (cost < 0) {
      errors.push({ line: lineNo, message: `negative amount: ${cost}` });
      return;
    }

    facts.push({
      source: "claude_team",
      day: asOf,
      costType: "overage",
      entityKey: email.toLowerCase(),
      costUsd: cost,
      model: modelCol >= 0 ? cells[modelCol] || null : null,
    });
  });

  return { facts, errors };
}
