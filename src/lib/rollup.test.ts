import { describe, expect, it } from "vitest";
import {
  byCostType,
  byDepartment,
  bySource,
  lastNMonths,
  monthlyByVendor,
  total,
  UNATTRIBUTED,
  type RollupRow,
} from "./rollup";

const rows: RollupRow[] = [
  { day: "2026-06-01", source: "cursor", costType: "metered", costUsd: 18.75, department: "Engineering" },
  { day: "2026-06-01", source: "claude_team", costType: "seat", costUsd: 30, department: "Engineering" },
  { day: "2026-06-01", source: "claude_team", costType: "overage", costUsd: 246.78, department: "Product" },
  { day: "2026-05-01", source: "cursor", costType: "metered", costUsd: 6.4, department: null },
];

describe("rollup", () => {
  it("totals and splits by cost type", () => {
    expect(total(rows)).toBeCloseTo(301.93);
    expect(byCostType(rows)).toEqual({ seat: 30, overage: 246.78, metered: 25.15 });
  });

  it("groups by source and department, sorted desc, bucketing nulls", () => {
    expect(bySource(rows)[0]).toEqual({ source: "claude_team", total: 276.78 });
    const depts = byDepartment(rows);
    expect(depts.find((d) => d.department === UNATTRIBUTED)?.total).toBe(6.4);
  });

  it("builds a monthly stacked series across the given months", () => {
    const months = lastNMonths(new Date("2026-06-15T00:00:00Z"), 2); // [2026-05, 2026-06]
    expect(months).toEqual(["2026-05", "2026-06"]);
    const series = monthlyByVendor(rows, months);
    expect(series[0]).toMatchObject({ month: "2026-05", cursor: 6.4 });
    expect(series[1]).toMatchObject({ month: "2026-06", cursor: 18.75, claude_team: 276.78 });
  });
});
