import type { SpendFact } from "@/lib/types";
import { parseHumanNumber, type ParseRowError } from "./types";

export interface ChatGptMember {
  /** display name as shown (often abbreviated, e.g. "Gareth J") */
  name: string;
  creditsSpent: number;
  messagesSent: number;
}

export interface ChatGptParseResult {
  /** overage facts (credits × rate), keyed by normalized display name */
  facts: SpendFact[];
  /** every active member, for ChatGPT seat assignment + activity */
  members: ChatGptMember[];
  errors: ParseRowError[];
}

/** Normalize a display name for keying (no email available from ChatGPT). */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * ChatGPT Business "Workspace analytics" table, copy/pasted as text
 * (reports/chatgpt member table.png). Columns: Name, Seat type, Credits spent,
 * Messages sent. No email — identity is resolved by fuzzy name match downstream
 * (see matchByName). Credits convert to USD overage via an admin credit rate.
 */
export function parseChatGptMemberTable(
  text: string,
  asOf: string,
  usdPerCredit: number,
): ChatGptParseResult {
  const facts: SpendFact[] = [];
  const members: ChatGptMember[] = [];
  const errors: ParseRowError[] = [];

  text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, i) => {
      const lower = line.toLowerCase();
      // skip header / scorecard rows
      if (lower.startsWith("name") || lower.includes("credits spent")) return;

      const cells = line.split(/\t|\s{2,}/).map((c) => c.trim());
      const name = cells[0];
      const numbers = cells
        .slice(1)
        .map(parseHumanNumber)
        .filter((n) => Number.isFinite(n));

      if (!name || numbers.length < 1) {
        errors.push({ line: i + 1, message: `unparseable row: "${line}"` });
        return;
      }
      // Column order after name (skipping "ChatGPT"): Credits spent, Messages sent
      const [creditsSpent = 0, messagesSent = 0] = numbers;

      members.push({ name, creditsSpent, messagesSent });

      if (creditsSpent > 0) {
        facts.push({
          source: "chatgpt_business",
          day: asOf,
          costType: "overage",
          entityKey: normalizeName(name),
          costUsd: creditsSpent * usdPerCredit,
          requests: messagesSent || null,
        });
      }
    });

  return { facts, members, errors };
}
