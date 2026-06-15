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

// Real copy/paste shape: 4 lines per member (the actual UI export).
const blockPasted = [
  "Name\tSeat type\tCredits spent\tMessages sent",
  "Omar Ali",
  "ChatGPT",
  "36K",
  "97",
  "Gareth J",
  "ChatGPT",
  "450",
  "6.72K",
  "Brandon Jones",
  "ChatGPT",
  "100",
  "213",
].join("\n");

describe("parseChatGptMemberTable (block format)", () => {
  it("parses 4-line blocks, handling K suffixes and the header", () => {
    const { members, errors } = parseChatGptMemberTable(blockPasted, "2026-06-15", 0.01);
    expect(errors).toEqual([]);
    expect(members).toEqual([
      { name: "Omar Ali", creditsSpent: 36000, messagesSent: 97 },
      { name: "Gareth J", creditsSpent: 450, messagesSent: 6720 },
      { name: "Brandon Jones", creditsSpent: 100, messagesSent: 213 },
    ]);
  });

  it("converts credits to USD overage facts keyed by normalized name", () => {
    const { facts } = parseChatGptMemberTable(blockPasted, "2026-06-15", 0.01);
    expect(facts).toHaveLength(3);
    expect(facts[0]).toMatchObject({ entityKey: "omar ali", costUsd: 360 }); // 36000 * 0.01
    expect(facts[1]).toMatchObject({ entityKey: "gareth j", costUsd: 4.5 });
  });
});
