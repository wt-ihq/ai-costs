import { describe, expect, it } from "vitest";
import { modelLabelFromUsageType } from "./openai-credits";

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
