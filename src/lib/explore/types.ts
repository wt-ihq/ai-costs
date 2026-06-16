import type { Vendor, CostType } from "@/lib/types";

export type Dim = "vendor" | "cost_type";

/** One month (or day) of stacked trend data; series keys are vendor/cost-type names. */
export type TrendPoint = { label: string } & Record<string, number | string>;

export interface TreemapNode {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface RankRow {
  id: string;
  label: string;
  total: number;
  sub?: string;
  href?: string;
  idle?: boolean;
  perHead?: number | null;
}

export interface Scorecard {
  total: number;
  prevTotal: number;
  seat: number;
  overage: number;
  metered: number;
}

export interface ExploreData {
  title: string;
  month: string;
  totalToDate: number;
  scorecard: Scorecard;
  trend: Record<Dim, TrendPoint[]>;
  treemap: Record<Dim, TreemapNode[]>;
  series: Record<Dim, string[]>;
  ranked: { kind: "team" | "person" | "lineitem"; rows: RankRow[] };
  daily?: Record<Dim, TrendPoint[]>;
}

export type { Vendor, CostType };
