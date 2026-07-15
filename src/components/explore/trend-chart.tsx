"use client";

import { useMemo } from "react";
import { Bar, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Dim, TrendPoint } from "@/lib/explore/types";
import { dimColorFor, dimLabel, seriesOrder } from "@/lib/explore/shape";
import type { ToolColors } from "@/lib/explore/shape";
import { formatUsd } from "@/lib/utils";

const AXIS = { stroke: "#8b92a5", fontSize: 11 };
const usd = (v: unknown) => formatUsd(Number(v));

/**
 * Y-axis tick: adaptive units. Person pages chart tens of dollars, where a
 * fixed `$Xk` formatter rendered every tick as "$0k".
 */
const usdTick = (v: unknown) => {
  const n = Number(v);
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(Math.abs(n) < 10_000 ? 1 : 0)}k`;
  return `$${Math.round(n)}`;
};

export function TrendChart({
  data,
  dim,
  height = 280,
  toolColors,
  projection,
}: {
  data: TrendPoint[];
  dim: Dim;
  height?: number;
  toolColors?: ToolColors;
  /** Forward month buckets carrying only a `projected` key — appended after the actuals. */
  projection?: TrendPoint[];
}) {
  const points = useMemo(() => (projection?.length ? [...data, ...projection] : data), [data, projection]);

  // Stacked series from ALL the data points (every dim value that appears in
  // any bucket): vendors by total desc, cost types canonical (seat at the base).
  // `projected` is drawn as its own dashed line, never as a bar.
  const series = useMemo(() => seriesOrder(points, dim).filter((k) => k !== "projected"), [points, dim]);

  const color = (k: string) => dimColorFor(dim, k, toolColors);
  const label = (k: string) => dimLabel(dim, k);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={points} margin={{ left: 8, right: 8, top: 8 }}>
        {/* Auto-thin ticks based on available width: shows every label when
            there's room, drops some only when they'd actually overlap. Keep
            minTickGap small so short labels (e.g. "Jan") all show on wide
            charts; long ones (e.g. "Jun 25") still thin on narrow screens. */}
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={5} {...AXIS} />
        <YAxis tickFormatter={usdTick} tickLine={false} axisLine={false} width={44} {...AXIS} />
        <Tooltip
          contentStyle={{ background: "#14171f", border: "1px solid #262b38", borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: "#e6e8ee" }}
          cursor={{ fill: "#ffffff0a" }}
          formatter={usd}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
        {series.map((k) => (
          <Bar key={k} dataKey={k} name={label(k)} stackId="1" fill={color(k)} radius={[2, 2, 0, 0]} maxBarSize={48} isAnimationActive />
        ))}
        {projection && projection.length > 0 && (
          // Dashed neutral line with hollow dots — a projection must never
          // read as actuals.
          <Line
            dataKey="projected"
            name="Projected"
            stroke="#8b92a5"
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={{ r: 3, stroke: "#8b92a5", strokeWidth: 1.5, fill: "#14171f" }}
            connectNulls={false}
            isAnimationActive
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
