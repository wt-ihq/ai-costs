import { describe, expect, it } from "vitest";
import { lastNMonths } from "./rollup";

describe("lastNMonths", () => {
  it("returns the last n month keys ending at the given date, oldest first", () => {
    expect(lastNMonths(new Date("2026-06-15T00:00:00Z"), 3)).toEqual(["2026-04", "2026-05", "2026-06"]);
  });
  it("crosses year boundaries", () => {
    expect(lastNMonths(new Date("2026-01-10T00:00:00Z"), 3)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });
});
