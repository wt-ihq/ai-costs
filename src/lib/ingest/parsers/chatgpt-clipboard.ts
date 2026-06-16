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

const HEADER_TOKENS = new Set(["name", "seat type", "credits spent", "messages sent"]);

/**
 * ChatGPT Business "Workspace analytics" table, copy/pasted as text. Columns:
 * Name, Seat type, Credits spent, Messages sent. No email — identity is
 * resolved by fuzzy name match downstream (matchByName). Credits convert to USD
 * overage via an admin credit rate.
 *
 * Two real paste shapes are supported:
 *   - block: each member is 4 lines (Name / "ChatGPT" / Credits / Messages) —
 *     how the table actually copies out of the UI.
 *   - row: one tab/space-separated line per member (some clients flatten it).
 */
export function parseChatGptMemberTable(
  text: string,
  asOf: string,
  usdPerCredit: number,
): ChatGptParseResult {
  const facts: SpendFact[] = [];
  const members: ChatGptMember[] = [];
  const errors: ParseRowError[] = [];

  const add = (name: string, creditsSpent: number, messagesSent: number) => {
    members.push({ name, creditsSpent, messagesSent });
    if (creditsSpent > 0) {
      facts.push({
        source: "chatgpt_business",
        day: asOf,
        costType: "overage",
        entityKey: normalizeName(name),
        costUsd: Math.round(creditsSpent * usdPerCredit * 100) / 100,
        requests: messagesSent || null,
      });
    }
  };

  // Drop blank lines and any header cells (combined or split across lines).
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.toLowerCase().includes("credits spent") && !HEADER_TOKENS.has(l.toLowerCase()));
  if (lines.length === 0) return { facts, members, errors };

  // Detect shape from the first data line: multiple columns => row mode.
  const rowMode = lines[0].split(/\t|\s{2,}/).length >= 3;

  if (rowMode) {
    lines.forEach((line, i) => {
      const cells = line.split(/\t|\s{2,}/).map((c) => c.trim());
      const name = cells[0];
      const nums = cells.slice(1).map(parseHumanNumber).filter(Number.isFinite);
      if (!name || nums.length < 1) {
        errors.push({ line: i + 1, message: `unparseable row: "${line}"` });
        return;
      }
      add(name, nums[0] ?? 0, nums[1] ?? 0);
    });
  } else {
    // Block mode: groups of 4 lines (name, seat type, credits, messages).
    for (let i = 0; i < lines.length; i += 4) {
      const name = lines[i];
      const credits = parseHumanNumber(lines[i + 2] ?? "");
      const messages = parseHumanNumber(lines[i + 3] ?? "0");
      if (lines[i + 2] === undefined) {
        errors.push({ line: i + 1, message: `incomplete record for "${name}"` });
        break;
      }
      if (!Number.isFinite(credits)) {
        errors.push({ line: i + 3, message: `unparseable credits "${lines[i + 2]}" for ${name}` });
        continue;
      }
      add(name, credits, Number.isFinite(messages) ? messages : 0);
    }
  }

  return { facts, members, errors };
}
