import { describe, expect, it } from "vitest";
import type { ResolvedFact } from "./persist";
import { applyServiceAccountTeams, cleanServiceAccountInput, serviceAccountIdOf, serviceAccountLabel, suggestedLabel } from "./cursor-service-accounts";

const SA = "cursor service account sa_6088564e-d3d3-43b0-a166-957eb316d402";
const fact = (entityKey: string, model = "github_bugbot", over: Partial<ResolvedFact> = {}): ResolvedFact => ({
  source: "cursor", day: "2026-10-01", costType: "overage", entityKey, costUsd: 5, model, employeeId: null, ...over,
});

describe("serviceAccountIdOf", () => {
  it("is the account id of a service-account entity, null for anything else", () => {
    expect(serviceAccountIdOf(SA)).toBe("sa_6088564e-d3d3-43b0-a166-957eb316d402");
    expect(serviceAccountIdOf("cursor service account (unknown)")).toBeNull();
    expect(serviceAccountIdOf("priya@x.com")).toBeNull();
  });
});

describe("suggestedLabel", () => {
  it("is Bugbot when every event is Cursor's code-review model, else nothing", () => {
    expect(suggestedLabel(["github_bugbot", "github_bugbot"])).toBe("Bugbot");
    expect(suggestedLabel(["github_bugbot", "claude-4.5-sonnet"])).toBeNull();
    expect(suggestedLabel([""])).toBeNull();
    expect(suggestedLabel([])).toBeNull();
  });
});

describe("applyServiceAccountTeams", () => {
  it("puts a mapped service account's spend on its team; people and unmapped accounts are untouched", () => {
    const teams = new Map([["sa_6088564e-d3d3-43b0-a166-957eb316d402", "Engineering"]]);
    const out = applyServiceAccountTeams([fact(SA), fact("cursor service account sa_other"), fact("priya@x.com", "gpt-5", { employeeId: "e1" })], teams);
    expect(out.map((f) => f.department ?? null)).toEqual(["Engineering", null, null]);
  });
});

describe("serviceAccountLabel", () => {
  it("names a labelled account, keeping its id; anything else is shown as is", () => {
    const labels = new Map([["sa_6088564e-d3d3-43b0-a166-957eb316d402", "Bugbot"]]);
    expect(serviceAccountLabel(SA, labels)).toBe("Bugbot (Cursor service account sa_6088564e…)");
    expect(serviceAccountLabel("cursor service account sa_other", labels)).toBe("cursor service account sa_other");
    expect(serviceAccountLabel("unkeyed", labels)).toBe("unkeyed");
  });
});

describe("cleanServiceAccountInput (the Data → Tools save)", () => {
  it("trims, and treats blanks as unset", () => {
    expect(cleanServiceAccountInput("sa_6088564e-d3d3", "  Bugbot ", " Engineering ")).toEqual({ accountId: "sa_6088564e-d3d3", label: "Bugbot", department: "Engineering" });
    expect(cleanServiceAccountInput("sa_1", "", null)).toEqual({ accountId: "sa_1", label: null, department: null });
  });
  it("rejects what isn't a service account or is too long", () => {
    expect(() => cleanServiceAccountInput("priya@x.com", "x", null)).toThrow("Invalid service account");
    expect(() => cleanServiceAccountInput("sa_1", "x".repeat(61), null)).toThrow("Name is too long");
    expect(() => cleanServiceAccountInput("sa_1", null, 42)).toThrow("Invalid team");
  });
});
