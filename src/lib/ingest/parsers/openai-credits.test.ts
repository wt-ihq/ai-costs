import { describe, expect, it } from "vitest";
import { modelLabelFromUsageType, parseOpenAiCreditsCsv, coveredWindow } from "./openai-credits";

describe("modelLabelFromUsageType", () => {
  // Every usage_type family observed in the real export (2026-07-13).
  it.each([
    // API token line items — input/cached_input/output/cache_write merge to one label
    ["api.gpt_5_5_2026_04_23_text_input_v_1", "GPT-5.5"],
    ["api.gpt_5_5_2026_04_23_text_cached_input_v_1", "GPT-5.5"],
    ["api.gpt_5_5_2026_04_23_text_output_v_1", "GPT-5.5"],
    ["api.gpt_5_4_2026_03_05_text_input_v_1", "GPT-5.4"],
    ["api.gpt_5_4_mini_2026_03_17_text_output_v_1", "GPT-5.4 mini"],
    ["api.gpt_5_2_2025_12_11_text_input_v_1", "GPT-5.2"],
    ["api.gpt_5_3_codex_text_cached_input_v_1", "GPT-5.3 Codex"],
    ["api.gpt_5_6_sol_text_cache_write_input_v_1", "GPT-5.6 Sol"],
    // codex_fast_ prefix → " Codex (fast)" suffix
    ["api.codex_fast_gpt_5_5_2026_04_23_text_input_v_1", "GPT-5.5 Codex (fast)"],
    ["api.codex_fast_gpt_5_6_sol_text_output_v_1", "GPT-5.6 Sol Codex (fast)"],
    ["api.codex_fast_gpt_5_6_luna_text_cached_input_v_1", "GPT-5.6 Luna Codex (fast)"],
    // ChatGPT message counts
    ["chat.completion.5.pro", "GPT-5 Pro (chat)"],
    ["chat.completion.4.5", "GPT-4.5 (chat)"],
    // Alphanumeric-only version segment (no numeric part) → no "GPT-" prefix
    ["chat.completion.4o", "4o (chat)"],
    ["chat_agent.completion", "ChatGPT Agent"],
    // Codex task counts
    ["codex", "Codex tasks"],
    ["codex.local.2", "Codex (local)"],
  ])("%s -> %s", (usageType, label) => {
    expect(modelLabelFromUsageType(usageType)).toBe(label);
  });

  it("degrades unknown types to a readable label, never throws", () => {
    expect(modelLabelFromUsageType("some.future_thing.v9")).toBe("some future thing v9");
  });
});

// Real header + representative rows from the actual export. The BOM is
// spelled \uFEFF explicitly so it can't be lost invisibly in copy/paste.
const HEADER =
  "\uFEFF" + "date_partition,account_id,account_user_id,email,name,public_id,usage_type,usage_credits,usage_quantity,usage_units";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

describe("parseOpenAiCreditsCsv", () => {
  it("merges token line items of one model into a single fact per (email, day, model)", () => {
    const { facts, errors, minDay, maxDay, totalCredits } = parseOpenAiCreditsCsv(csv(
      "2026-05-02,acc1,u1,Alex.Morgan@intenthq.com,Alex Morgan,user-1,api.codex_fast_gpt_5_5_2026_04_23_text_input_v_1,100.5,1000000,tokens",
      "2026-05-02,acc1,u1,alex.morgan@intenthq.com,Alex Morgan,user-1,api.codex_fast_gpt_5_5_2026_04_23_text_cached_input_v_1,50.25,5000000,tokens",
      "2026-05-02,acc1,u1,alex.morgan@intenthq.com,Alex Morgan,user-1,api.codex_fast_gpt_5_5_2026_04_23_text_output_v_1,25,200000,tokens",
    ));
    expect(errors).toEqual([]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({
      email: "alex.morgan@intenthq.com", // lowercased
      name: "Alex Morgan",
      day: "2026-05-02",
      model: "GPT-5.5 Codex (fast)",
      credits: 175.75,
      tokens: 6200000,
      requests: null,
    });
    expect(minDay).toBe("2026-05-02");
    expect(maxDay).toBe("2026-05-02");
    expect(totalCredits).toBeCloseTo(175.75);
  });

  it("puts count-based usage in requests, keeps distinct models separate", () => {
    const { facts } = parseOpenAiCreditsCsv(csv(
      "2025-08-14,acc1,u2,jamie.lee@intenthq.com,Jamie Lee,user-2,chat.completion.5.pro,400.0,8.0,counts",
      "2025-08-14,acc1,u2,jamie.lee@intenthq.com,Jamie Lee,user-2,codex,120,3,counts",
    ));
    expect(facts).toHaveLength(2);
    const pro = facts.find((f) => f.model === "GPT-5 Pro (chat)");
    expect(pro).toMatchObject({ credits: 400, requests: 8, tokens: null });
    expect(facts.find((f) => f.model === "Codex tasks")).toMatchObject({ credits: 120, requests: 3 });
  });

  it("collects per-row errors for bad rows and keeps the good ones", () => {
    const { facts, errors } = parseOpenAiCreditsCsv(csv(
      "not-a-date,acc1,u1,x@intenthq.com,X,user-1,codex,10,1,counts",
      "2026-05-02,acc1,u1,,No Email,user-1,codex,10,1,counts",
      "2026-05-03,acc1,u1,ok@intenthq.com,OK,user-1,codex,10,1,counts",
    ));
    expect(facts).toHaveLength(1);
    expect(facts[0].email).toBe("ok@intenthq.com");
    expect(errors).toHaveLength(2);
    expect(errors[0].line).toBe(2); // 1-based, header is line 1
  });

  it("handles quoted fields containing commas", () => {
    const { facts } = parseOpenAiCreditsCsv(csv(
      '2026-05-02,acc1,u1,jo@intenthq.com,"Jones, Jo",user-1,codex,10,1,counts',
    ));
    expect(facts[0].name).toBe("Jones, Jo");
  });

  it("throws on header drift (missing required column)", () => {
    const bad = "date_partition,account_id,email,usage_credits\n2026-05-02,acc1,x@intenthq.com,10";
    expect(() => parseOpenAiCreditsCsv(bad)).toThrow(/missing column/i);
  });

  it("returns an error (not a throw) for an empty file", () => {
    const { facts, errors } = parseOpenAiCreditsCsv("");
    expect(facts).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("rejects a blank usage_credits cell as a bad row, not a 0-credit fact", () => {
    const { facts, errors } = parseOpenAiCreditsCsv(csv(
      "2026-05-02,acc1,u1,x@intenthq.com,X,user-1,codex,  ,1,counts",
    ));
    expect(facts).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("counts credits from an unknown usage_units value without contributing to tokens or requests", () => {
    const { facts } = parseOpenAiCreditsCsv(csv(
      "2026-05-02,acc1,u1,x@intenthq.com,X,user-1,codex,10,5,widgets",
    ));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ credits: 10, tokens: null, requests: null });
  });

  it("sums a zero usage_quantity without throwing or dropping the row", () => {
    const { facts } = parseOpenAiCreditsCsv(csv(
      "2026-05-02,acc1,u1,x@intenthq.com,X,user-1,codex,10,0,counts",
    ));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ credits: 10, requests: 0 });
  });

  it("sums a negative usage_quantity (adjustment row reduces requests)", () => {
    const { facts } = parseOpenAiCreditsCsv(csv(
      "2026-05-02,acc1,u1,x@intenthq.com,X,user-1,codex,20,8,counts",
      "2026-05-02,acc1,u1,x@intenthq.com,X,user-1,codex,-5,-5,counts",
    ));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ credits: 15, requests: 3 });
  });

  it("preserves true line numbers when a blank line sits between header and a bad row", () => {
    const { errors } = parseOpenAiCreditsCsv(
      [HEADER, "", "not-a-date,acc1,u1,x@intenthq.com,X,user-1,codex,10,1,counts"].join("\n"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(3); // header=1, blank=2, bad row=3
  });
});

describe("coveredWindow", () => {
  it("month-aligns the start (sweeps old month-stamped paste overage) and is exclusive-end", () => {
    expect(coveredWindow("2025-08-14", "2026-07-11")).toEqual({ startDate: "2025-08-01", endDate: "2026-07-12" });
  });

  it("rolls the end over month and year boundaries", () => {
    expect(coveredWindow("2026-12-05", "2026-12-31")).toEqual({ startDate: "2026-12-01", endDate: "2027-01-01" });
  });
});
