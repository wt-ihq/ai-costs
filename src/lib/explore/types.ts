import type { Vendor, CostType } from "@/lib/types";
import type { Period, Granularity } from "./period";

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
  seat: number;
  overage: number;
  metered: number;
}

export interface ExploreData {
  title: string;
  period: Period;
  earliest: string;
  totalToDate: number;
  scorecard: Scorecard;
  trend: Record<Dim, TrendPoint[]>;
  treemap: Record<Dim, TreemapNode[]>;
  ranked: { kind: "team" | "person" | "lineitem"; rows: RankRow[] };
}

export type { Vendor, CostType, Period, Granularity };
