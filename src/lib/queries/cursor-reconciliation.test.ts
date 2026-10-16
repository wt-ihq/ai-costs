import { describe, expect, it } from "vitest";
import { reconcileCursor } from "./cursor-reconciliation";

describe("reconcileCursor", () => {
  const facts = [
    { entityKey: "a@intenthq.com", costUsd: 200.25 },
    { entityKey: "b@intenthq.com", costUsd: 138.75 },
    { entityKey: "cursor service account sa_1", costUsd: 120 },
  ];

  it("compares people's on-demand spend with Cursor's on-demand total, service accounts apart", () => {
    const r = reconcileCursor({ cycleStart: "2026-10-11", spendCents: 33900, overallCents: 233700, facts });
    expect(r).toEqual({
      cycleStart: "2026-10-11",
      cursorSpendUsd: 339,
      cursorOverallUsd: 2337,
      ourOverageUsd: 339,
      serviceAccountUsd: 120,
      deltaUsd: 0,
      deltaPct: 0,
    });
  });

  it("reports the drift, and no percentage against a zero total", () => {
    expect(reconcileCursor({ cycleStart: "2026-10-11", spendCents: 30000, overallCents: null, facts })).toMatchObject({ deltaUsd: 39, deltaPct: 13, cursorOverallUsd: null });
    expect(reconcileCursor({ cycleStart: "2026-10-11", spendCents: 0, overallCents: null, facts }).deltaPct).toBeNull();
  });
});
