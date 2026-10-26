import { describe, expect, it } from "vitest";
import { lastUpdatedFrom, lastUpdatedLabel, lastUpdatedForNode } from "./last-updated";

describe("lastUpdatedFrom", () => {
  it("reads automatic sources from their last successful sync and manual imports from the latest paste", () => {
    const out = lastUpdatedFrom(
      { cursor: "2026-10-26T06:01:45+00:00", anthropic: "2026-10-26T06:00:52+00:00", recurring: "2026-10-25T06:00:51+00:00" },
      { chatgpt_business: "2026-09-30", claude_team: "2026-10-19", cursor: "2026-07-31" },
    );
    expect(out.cursor).toBe("2026-10-26"); // the sync, not the old paste
    expect(out.anthropic).toBe("2026-10-26");
    expect(out.chatgpt_business).toBe("2026-09-30");
    expect(out.claude_team).toBe("2026-10-19");
    expect(out.other).toBe("2026-10-25"); // the recurring-costs materialiser
  });

  it("is null for a source that has never updated, and covers every vendor", () => {
    const out = lastUpdatedFrom({}, {});
    expect(Object.keys(out).sort()).toEqual(["anthropic", "chatgpt_business", "claude_team", "cursor", "openai", "openrouter", "other", "vercel"]);
    expect(Object.values(out).every((v) => v === null)).toBe(true);
  });
});

describe("lastUpdatedLabel", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  it("names the day, and the year only when it's not this year", () => {
    expect(lastUpdatedLabel("2026-10-26", now)).toBe("Updated 26 Oct");
    expect(lastUpdatedLabel("2025-12-31", now)).toBe("Updated 31 Dec 2025");
  });
  it("says so when there's nothing", () => {
    expect(lastUpdatedLabel(null, now)).toBe("Never updated");
  });
});

describe("lastUpdatedForNode", () => {
  const lu = { cursor: "2026-10-26", other: "2026-10-25", anthropic: null } as const;
  it("resolves a vendor key, and an other:<tool> key to the recurring-costs date", () => {
    expect(lastUpdatedForNode("cursor", lu)).toBe("2026-10-26");
    expect(lastUpdatedForNode("other:Figma", lu)).toBe("2026-10-25");
    expect(lastUpdatedForNode("anthropic", lu)).toBeNull();
  });
  it("has nothing to say for the rolled-up Other row", () => {
    expect(lastUpdatedForNode("__other__", lu)).toBeUndefined();
  });
});
