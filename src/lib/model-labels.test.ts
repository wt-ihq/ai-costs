import { describe, expect, it } from "vitest";
import { modelLabel } from "./model-labels";

describe("modelLabel", () => {
  it("names Cursor's code-review model for people", () => {
    expect(modelLabel("github_bugbot")).toBe("Cursor - Bugbot");
  });
  it("leaves every other model as reported", () => {
    expect(modelLabel("claude-4.5-sonnet")).toBe("claude-4.5-sonnet");
    expect(modelLabel("")).toBe("");
  });
});
