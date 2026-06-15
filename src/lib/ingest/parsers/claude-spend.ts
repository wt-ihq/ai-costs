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
 * ⚠ CURRENCY: amounts are GBP (£), but the spec scopes v1 as USD-only / no FX
 * (§2, §10). This parser returns the NATIVE GBP value; converting to USD is a
 * pending product decision (fixed admin rate vs. native + currency column).
 * Identity is email-keyed (clean). MTD is cumulative → emit one monthly fact
 * per user downstream, upsert-REPLACE, never sum.
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
