import { describe, expect, it } from "vitest";
import { parseClaudeSpend } from "./claude-spend";

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
