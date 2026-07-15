import { describe, expect, it } from "vitest";
import { packFacts, unpackFacts } from "./pack";
import type { ShapeFact } from "./shape";

const fact = (over: Partial<ShapeFact>): ShapeFact => ({
  day: "2026-06-01",
  source: "cursor",
  costType: "seat",
  costUsd: 40,
  employeeId: "e1",
  department: "Engineering",
  fullName: "Alex Morgan",
  entityKey: "alex.morgan@intenthq.com",
  model: "",
  ...over,
});

describe("packFacts / unpackFacts", () => {
  it("round-trips losslessly, including nulls and negative amounts", () => {
    const facts: ShapeFact[] = [
      fact({}),
      fact({ day: "2026-07-01", costType: "overage", costUsd: -5.37, model: "GPT-5.5 Codex (fast)" }),
      fact({ employeeId: null, fullName: null, department: null, entityKey: "unassigned seats", source: "chatgpt_business" }),
      fact({ source: "other", costType: "subscription", entityKey: "openrouter|Technology", model: "OpenRouter", department: "Technology", employeeId: null, fullName: null }),
    ];
    expect(unpackFacts(packFacts(facts))).toEqual(facts);
  });

  it("preserves order and handles empty input", () => {
    expect(unpackFacts(packFacts([]))).toEqual([]);
    const facts = [fact({ day: "2026-03-01" }), fact({ day: "2026-01-01" }), fact({ day: "2026-02-01" })];
    expect(unpackFacts(packFacts(facts)).map((f) => f.day)).toEqual(["2026-03-01", "2026-01-01", "2026-02-01"]);
  });

  it("actually compresses: repeated strings intern once", () => {
    const facts = Array.from({ length: 1000 }, (_, i) => fact({ costUsd: i }));
    const packed = packFacts(facts);
    expect(packed.employeeIds).toEqual(["e1"]);
    expect(packed.departments).toEqual(["Engineering"]);
    const packedBytes = JSON.stringify(packed).length;
    const rawBytes = JSON.stringify(facts).length;
    expect(packedBytes).toBeLessThan(rawBytes * 0.35); // >65% smaller on repetitive data
  });
});
