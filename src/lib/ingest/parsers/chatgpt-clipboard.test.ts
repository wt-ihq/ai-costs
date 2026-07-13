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
    const { members } = parseChatGptMemberTable(pasted);
    expect(members.map((m) => m.name)).toEqual([
      "Benjamin Haas",
      "Igor Perchersky",
      "Alexander Vlasik",
    ]);
    expect(members[2].creditsSpent).toBe(16100); // 16.1K
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
    const { members, errors } = parseChatGptMemberTable(blockPasted);
    expect(errors).toEqual([]);
    expect(members).toEqual([
      { name: "Omar Ali", creditsSpent: 36000, messagesSent: 97 },
      { name: "Gareth J", creditsSpent: 450, messagesSent: 6720 },
      { name: "Brandon Jones", creditsSpent: 100, messagesSent: 213 },
    ]);
  });
});
