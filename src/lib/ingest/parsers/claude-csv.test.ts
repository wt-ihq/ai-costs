import { describe, expect, it } from "vitest";
import { parseClaudeTeamCsv } from "./claude-csv";

describe("parseClaudeTeamCsv", () => {
  it("parses valid rows into overage facts", () => {
    const csv = "email,model,cost_usd\nalice@intenthq.com,opus,12.50\nbob@intenthq.com,sonnet,3.20";
    const { facts, errors } = parseClaudeTeamCsv(csv, "2026-06-01");
    expect(errors).toEqual([]);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      source: "claude_team",
      costType: "overage",
      entityKey: "alice@intenthq.com",
      costUsd: 12.5,
    });
  });

  it("flags negative and non-numeric amounts per row", () => {
    const csv = "email,cost_usd\nalice@intenthq.com,-5\nbob@intenthq.com,abc";
    const { errors } = parseClaudeTeamCsv(csv, "2026-06-01");
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toMatch(/negative/);
    expect(errors[1].message).toMatch(/non-numeric/);
  });

  it("rejects a file missing required columns", () => {
    const { facts, errors } = parseClaudeTeamCsv("foo,bar\n1,2", "2026-06-01");
    expect(facts).toEqual([]);
    expect(errors[0].message).toMatch(/missing required columns/);
  });
});
