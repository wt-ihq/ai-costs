import type { SpendFact } from "@/lib/types";
import type { ClaudeSpendResult, ClaudeSpendRow } from "./types";

/**
 * Claude Team "Custom spend limit / MTD spend" dashboard, copy/pasted as text
 * (reports/claude MTD spend.txt). No clean export — this is the pasted column.
 *
 * Layout is a 3-line block per member, blank-line separated:
 *     Mark Bunn
 *     mark.bunn@intenthq.com
 *     –\t£0.00                 (or "Unavailable\t£0.00" for inactive seats)
 *
 * CURRENCY: amounts are GBP (£). Decision: convert to USD at ingest via a
 * fixed admin-configured rate (fx_rates.GBP), keeping spend_facts single-
 * currency; native £ is retained in raw_payloads. See buildClaudeSpendFacts.
 * Identity is email-keyed (clean). MTD is cumulative → emit one monthly fact
 * per user, keyed to the month, upsert-REPLACE, never sum.
 */
export function parseClaudeSpend(text: string): ClaudeSpendResult {
  const rows: ClaudeSpendRow[] = [];
  const errors: ClaudeSpendResult["errors"] = [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== "Custom spend limit" && l !== "MTD spend");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("@")) continue; // only email lines anchor a record

    const email = line.toLowerCase();
    const name = lines[i - 1] ?? "";
    const spendLine = lines[i + 1] ?? "";

    const m = /£\s*([\d,]+(?:\.\d+)?)/.exec(spendLine);
    if (!m) {
      errors.push({ line: i + 2, message: `no £ amount after ${email}` });
      continue;
    }
    rows.push({
      name,
      email,
      mtdGbp: Number(m[1].replace(/,/g, "")),
      available: !/^unavailable/i.test(spendLine),
    });
  }

  return { rows, errors };
}

/**
 * Convert parsed Claude rows to monthly overage facts in USD.
 * `monthIso` is any date in the target month; the fact is keyed to the 1st so
 * re-importing the same month upserts/replaces rather than accumulating.
 * `usdPerGbp` comes from fx_rates.GBP.
 */
export function buildClaudeSpendFacts(
  rows: ClaudeSpendRow[],
  monthIso: string,
  usdPerGbp: number,
): SpendFact[] {
  const day = monthIso.slice(0, 7) + "-01";
  return rows
    .filter((r) => r.mtdGbp > 0)
    .map((r) => ({
      source: "claude_team",
      day,
      costType: "overage",
      entityKey: r.email,
      costUsd: Math.round(r.mtdGbp * usdPerGbp * 100) / 100,
    }));
}
