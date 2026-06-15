import type { SpendFact } from "@/lib/types";
import { parseHumanNumber, type FactParseResult } from "./types";

/**
 * Claude Team spend dashboard — per-user month-to-date (MTD) overage.
 * Columns (per Gareth): Name, Email, MTD spend. Email-keyed (clean matching).
 *
 * ⚠ PENDING: the real export sample hasn't been captured yet (the file dropped
 * as "claude spend.png" was a mislabeled copy of the ChatGPT table). Column
 * names / paste shape below are the assumed form and MUST be pinned against a
 * real sample before relying on this (spec §11 week-1 validation).
 *
 * MTD is cumulative for the month, so we emit ONE monthly fact per user keyed
 * to the month (day = first of month). Re-capturing the same month upserts and
 * REPLACES — it must never sum, or repeated pulls double-count.
 */
export function parseClaudeSpend(text: string, monthIso: string): FactParseResult {
  const facts: SpendFact[] = [];
  const errors: FactParseResult["errors"] = [];
  const day = monthIso.slice(0, 7) + "-01"; // normalize to first of month

  text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line, i) => {
      const cells = line.split(/\t|\s{2,}/).map((c) => c.trim());
      const email = cells.find((c) => c.includes("@"))?.toLowerCase();
      const spendCell = cells.find((c) => /\$?[\d.,]+[KMB]?$/i.test(c));
      if (!email) {
        if (i > 0) errors.push({ line: i + 1, message: "no email in row" });
        return;
      }
      const spend = spendCell ? parseHumanNumber(spendCell.replace(/\$/g, "")) : 0;
      if (!Number.isFinite(spend) || spend < 0) {
        errors.push({ line: i + 1, message: `bad MTD spend: "${spendCell}"` });
        return;
      }
      if (spend > 0) {
        facts.push({
          source: "claude_team",
          day,
          costType: "overage",
          entityKey: email,
          costUsd: spend,
        });
      }
    });

  return { facts, errors };
}
