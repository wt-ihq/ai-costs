import { describe, expect, it } from "vitest";
import type { Period } from "@/lib/explore/period";
import type { CursorSpendRow } from "@/lib/queries/cursor-spend";
import { buildCursorSpendData } from "./spend-shape";

const JUNE: Period = {
  granularity: "month",
  anchor: "2026-06",
  from: "2026-06-01",
  toExclusive: "2026-07-01",
  label: "June 2026",
  isCurrent: false,
};

const row = (over: Partial<CursorSpendRow>): CursorSpendRow => ({
  day: "2026-06-10",
  costType: "overage",
  model: "claude-sonnet-5",
  costUsd: 10,
  personName: "Ada Lovelace",
  ...over,
});

describe("buildCursorSpendData", () => {
  it("slices by period and splits seat vs overage", () => {
    const data = buildCursorSpendData(
      {
        rows: [
          row({ costType: "seat", model: "", costUsd: 40 }),
          row({ costUsd: 12 }),
          row({ day: "2026-07-01", costUsd: 99 }), // outside (exclusive end)
          row({ day: "2026-05-31", costUsd: 99 }), // outside
        ],
      },
      JUNE,
    );
    expect(data.seat).toBe(40);
    expect(data.overage).toBe(12);
    expect(data.total).toBe(52);
  });

  it("groups overage by model with (no model) bucket, sorted desc", () => {
    const data = buildCursorSpendData(
      {
        rows: [
          row({ model: "claude-sonnet-5", costUsd: 5 }),
          row({ model: "", costUsd: 2 }),
          row({ model: "gpt-5", costUsd: 8 }),
          row({ costType: "seat", model: "", costUsd: 40 }), // seats never enter byModel
        ],
      },
      JUNE,
    );
    expect(data.byModel).toEqual([
      { model: "gpt-5", cost: 8 },
      { model: "claude-sonnet-5", cost: 5 },
      { model: "(no model)", cost: 2 },
    ]);
  });

  it("groups seat+overage by person with Unattributed bucket, sorted desc", () => {
    const data = buildCursorSpendData(
      {
        rows: [
          row({ personName: "Ada Lovelace", costType: "seat", model: "", costUsd: 40 }),
          row({ personName: "Ada Lovelace", costUsd: 3 }),
          row({ personName: null, costUsd: 7 }),
          row({ personName: "Grace Hopper", costUsd: 50 }),
        ],
      },
      JUNE,
    );
    expect(data.byPerson).toEqual([
      { name: "Grace Hopper", cost: 50 },
      { name: "Ada Lovelace", cost: 43 },
      { name: "Unattributed", cost: 7 },
    ]);
  });

  it("handles empty input", () => {
    const data = buildCursorSpendData({ rows: [] }, JUNE);
    expect(data).toEqual({ total: 0, seat: 0, overage: 0, byModel: [], byPerson: [] });
  });
});
