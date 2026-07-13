import { describe, expect, it } from "vitest";
import { parseChatGptMemberTable } from "./chatgpt-clipboard";

// Tab-separated paste of the Workspace analytics table (real shape).
const pasted = [
  "Name\tSeat type\tCredits spent\tMessages sent",
  "Casey Ford\tChatGPT\t0\t1.06K",
  "Riley Chen\tChatGPT\t3.81K\t304",
  "Jordan Blake\tChatGPT\t16.1K\t217",
].join("\n");

describe("parseChatGptMemberTable", () => {
  it("skips the header and lists every active member", () => {
    const { members } = parseChatGptMemberTable(pasted);
    expect(members.map((m) => m.name)).toEqual([
      "Casey Ford",
      "Riley Chen",
      "Jordan Blake",
    ]);
    expect(members[2].creditsSpent).toBe(16100); // 16.1K
  });
});

// Real copy/paste shape: 4 lines per member (the actual UI export).
const blockPasted = [
  "Name\tSeat type\tCredits spent\tMessages sent",
  "Alex Morgan",
  "ChatGPT",
  "36K",
  "97",
  "Gareth J",
  "ChatGPT",
  "450",
  "6.72K",
  "Morgan Reid",
  "ChatGPT",
  "100",
  "213",
].join("\n");

describe("parseChatGptMemberTable (block format)", () => {
  it("parses 4-line blocks, handling K suffixes and the header", () => {
    const { members, errors } = parseChatGptMemberTable(blockPasted);
    expect(errors).toEqual([]);
    expect(members).toEqual([
      { name: "Alex Morgan", creditsSpent: 36000, messagesSent: 97 },
      { name: "Gareth J", creditsSpent: 450, messagesSent: 6720 },
      { name: "Morgan Reid", creditsSpent: 100, messagesSent: 213 },
    ]);
  });
});
