import { describe, expect, it } from "vitest";
import { parseChatGptMemberTable } from "./chatgpt-clipboard";

// Tab-separated paste of the Workspace analytics table (real shape).
const pasted = [
  "Name\tSeat type\tCredits spent\tMessages sent",
  "Benjamin Haas\tChatGPT\t0\t1.06K",
  "Igor Perchersky\tChatGPT\t3.81K\t304",
  "Alexander Vlasik\tChatGPT\t16.1K\t217",
].join("\n");

describe("parseChatGptMemberTable", () => {
  it("skips the header and lists every active member", () => {
    const { members } = parseChatGptMemberTable(pasted, "2026-06-13", 0.01);
    expect(members.map((m) => m.name)).toEqual([
      "Benjamin Haas",
      "Igor Perchersky",
      "Alexander Vlasik",
    ]);
    expect(members[2].creditsSpent).toBe(16100); // 16.1K
  });

  it("emits overage facts only for members with credits, converted via rate", () => {
    const { facts } = parseChatGptMemberTable(pasted, "2026-06-13", 0.01);
    expect(facts).toHaveLength(2); // Benjamin Haas has 0 credits
    expect(facts[0]).toMatchObject({
      source: "chatgpt_business",
      costType: "overage",
      entityKey: "igor perchersky",
      costUsd: 38.1, // 3810 credits * 0.01
    });
  });
});
