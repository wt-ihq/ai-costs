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

/** One slice of a row's spend, by the active dim (vendor or cost type). */
export interface RankSegment {
  key: string; // vendor or cost_type value
  value: number; // USD
  color: string;
}

export interface RankRow {
  id: string;
  label: string;
  total: number;
  sub?: string;
  href?: string;
  perHead?: number | null;
  /** Spend split for the color-coded bar, precomputed for both dims. */
  segments?: Record<Dim, RankSegment[]>;
}

export interface Scorecard {
  total: number;
  seat: number;
  subscription: number;
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
  /** `tools`: department-attributed recurring tools, shown as their own list on team pages. */
  ranked: { kind: "team" | "person" | "lineitem"; rows: RankRow[]; tools?: RankRow[] };
  allStaff?: RankRow[];
  /** Month-end forecast + dashed trend extension, from the same filtered facts. */
  projection: { periodEnd: import("./project").PeriodProjection | null; trend: TrendPoint[] };
}

export type { Vendor, CostType, Period, Granularity };
