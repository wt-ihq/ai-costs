import { describe, expect, it } from "vitest";
import { resolveKeys } from "./reattribute";

const employees = [
  { id: "e1", email: "gareth.jones@intenthq.com" },
  { id: "e2", email: "tom.reeve@intenthq.com" },
];

describe("resolveKeys", () => {
  it("resolves email keys (case-insensitively) to employee ids", () => {
    const map = resolveKeys(["Gareth.Jones@intenthq.com", "tom.reeve@intenthq.com"], employees);
    expect(map.get("Gareth.Jones@intenthq.com")).toBe("e1");
    expect(map.get("tom.reeve@intenthq.com")).toBe("e2");
  });

  it("leaves non-email keys (API key / project ids) unresolved", () => {
    const map = resolveKeys(["apikey_abc123", "proj_xyz"], employees);
    expect(map.size).toBe(0);
  });

  it("omits emails with no matching employee", () => {
    const map = resolveKeys(["contractor@external.dev"], employees);
    expect(map.has("contractor@external.dev")).toBe(false);
  });
});
