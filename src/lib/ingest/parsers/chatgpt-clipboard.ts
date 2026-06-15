import type { SpendFact } from "@/lib/types";
import type { ParseResult } from "./claude-csv";

/**
 * ChatGPT Business member-table paste (spec §6). The admin copies the member
 * table from the ChatGPT admin UI; we parse the tab/multi-space separated text,
 * including the per-user credits column for overage. Credits convert to USD via
 * an admin-configured `usdPerCredit` rate.
 *
 * Seat cost is generated from seat_assignments; here we emit only overage.
 * No documented CSV export exists, hence paste-first with a hand-keyed fallback.
 */
export function parseChatGptMemberTable(
  text: string,
  asOf: string,
  usdPerCredit: number,
): ParseResult {
  const facts: SpendFact[] = [];
  const errors: ParseResult["errors"] = [];

  const rows = text.trim().split(/\r?\n/).filter(Boolean);
  rows.forEach((row, i) => {
    const cells = row.split(/\t|\s{2,}/).map((c) => c.trim());
    const email = cells.find((c) => c.includes("@"));
    const creditsCell = cells.find((c) => /^\d[\d,.]*$/.test(c.replace(/,/g, "")));

    if (!email) {
      // header / separator rows are skipped, not errored
      if (i > 0) errors.push({ line: i + 1, message: "no email found in row" });
      return;
    }
    const credits = creditsCell ? Number(creditsCell.replace(/,/g, "")) : 0;
    if (credits > 0) {
      facts.push({
        source: "chatgpt_business",
        day: asOf,
        costType: "overage",
        entityKey: email.toLowerCase(),
        costUsd: credits * usdPerCredit,
      });
    }
  });

  return { facts, errors };
}
