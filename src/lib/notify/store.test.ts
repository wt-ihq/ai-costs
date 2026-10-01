import { describe, expect, it } from "vitest";
import { canRetakeClaim, MAX_SEND_ATTEMPTS } from "./store";

describe("canRetakeClaim", () => {
  it("only retakes FAILED rows that still have attempts left", () => {
    expect(canRetakeClaim({ status: "failed", attempts: 1 })).toBe(true);
    expect(canRetakeClaim({ status: "failed", attempts: MAX_SEND_ATTEMPTS })).toBe(false);
    for (const status of ["sent", "skipped", "pending"]) expect(canRetakeClaim({ status, attempts: 1 })).toBe(false);
  });
});
