import { describe, expect, it } from "vitest";
import { buildClaudeSpendFacts, parseClaudeSpend } from "./claude-spend";

// Real 3-line-block shape from reports/claude MTD spend.txt
const pasted = [
  "Custom spend limit",
  "MTD spend",
  "",
  "Jason Cornock",
  "jason.cornock@intenthq.com",
  "–\t£4.54",
  "",
  "Jerry Marcel Lieveld",
  "jerry.lieveld@intenthq.com",
  "–\t£1,030.72",
  "",
  "Kipp Gearhart",
  "kipp.gearhart@intenthq.com",
  "Unavailable\t£0.00",
].join("\n");

describe("parseClaudeSpend", () => {
  it("parses 3-line blocks into email-keyed GBP rows", () => {
    const { rows, errors } = parseClaudeSpend(pasted);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      name: "Jason Cornock",
      email: "jason.cornock@intenthq.com",
      mtdGbp: 4.54,
      available: true,
    });
  });

  it("handles comma thousands separators", () => {
    const { rows } = parseClaudeSpend(pasted);
    expect(rows[1].mtdGbp).toBe(1030.72);
  });

  it("flags inactive seats via the 'Unavailable' limit column", () => {
    const { rows } = parseClaudeSpend(pasted);
    expect(rows[2].available).toBe(false);
    expect(rows[2].mtdGbp).toBe(0);
  });
});

describe("buildClaudeSpendFacts", () => {
  const { rows } = parseClaudeSpend(pasted);

  it("converts GBP to USD monthly overage facts, dropping zero-spend rows", () => {
    const facts = buildClaudeSpendFacts(rows, "2026-06-13", 1.27);
    expect(facts).toHaveLength(2); // only the two non-zero rows
    expect(facts[0]).toEqual({
      source: "claude_team",
      day: "2026-06-01", // keyed to the month for upsert-replace
      costType: "overage",
      entityKey: "jason.cornock@intenthq.com",
      costUsd: 5.77, // 4.54 * 1.27 = 5.7658 -> 5.77
    });
  });

  it("keys facts to the 1st of the month so re-imports replace, not accumulate", () => {
    const facts = buildClaudeSpendFacts(rows, "2026-06-30", 1.27);
    expect(facts.every((f) => f.day === "2026-06-01")).toBe(true);
  });
});
