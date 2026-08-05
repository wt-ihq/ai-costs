"use client";

import { useMemo } from "react";
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { UsageTrendPoint } from "@/lib/cursor-models/shape";
import { modelColor } from "@/lib/cursor-models/shape";
import { OTHER_MODELS } from "@/lib/openrouter/shape";
import { formatUsd } from "@/lib/utils";

const AXIS = { stroke: "#8b92a5", fontSize: 11 };
const TOOLTIP = {
  contentStyle: { background: "#14171f", border: "1px solid #262b38", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "#e6e8ee" },
  cursor: { fill: "#ffffff0a" },
  formatter: (v: unknown) => formatUsd(Number(v)),
};

const seriesColor = (k: string) => (k === OTHER_MODELS ? "#8b92a5" : modelColor(k));

/**
 * Stacked USD-per-model trend across the period's buckets (the shaper caps
 * series and clips empty edge buckets). Few buckets (monthly views, or a
 * month that's only a few days old) render as horizontal rows — a full-width
 * stacked bar per bucket — because a couple of skinny columns floating in a
 * wide panel is unreadable; dense daily views stay vertical columns.
 */
export function SpendTrendChart({ data }: { data: UsageTrendPoint[] }) {
  // Series = every model that appears in any bucket, ordered by total desc,
  // with the Other bucket pinned last (end of the stack and the legend).
  const series = useMemo(() => {
    const totals = new Map<string, number>();
    for (const p of data) {
      for (const [k, v] of Object.entries(p)) {
        if (k === "label" || typeof v !== "number") continue;
        totals.set(k, (totals.get(k) ?? 0) + v);
      }
    }
    return [...totals.entries()]
      .sort((a, b) => (a[0] === OTHER_MODELS ? 1 : b[0] === OTHER_MODELS ? -1 : b[1] - a[1]))
      .map(([k]) => k);
  }, [data]);

  const horizontal = data.length <= 12;
  const height = horizontal ? Math.max(data.length * 44 + 70, 180) : 280;

  return (
    <ResponsiveContainer width="100%" height={height}>
      {horizontal ? (
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 8 }}>
          <XAxis type="number" tickFormatter={(v) => formatUsd(Number(v))} tickLine={false} axisLine={false} {...AXIS} />
          <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={44} {...AXIS} />
          <Tooltip {...TOOLTIP} />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
          {series.map((k) => (
            <Bar key={k} dataKey={k} name={k} stackId="1" fill={seriesColor(k)} maxBarSize={28} isAnimationActive />
          ))}
        </BarChart>
      ) : (
        <BarChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={5} {...AXIS} />
          <YAxis tickFormatter={(v) => formatUsd(Number(v))} tickLine={false} axisLine={false} width={56} {...AXIS} />
          <Tooltip {...TOOLTIP} />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
          {series.map((k) => (
            <Bar key={k} dataKey={k} name={k} stackId="1" fill={seriesColor(k)} radius={[2, 2, 0, 0]} maxBarSize={48} isAnimationActive />
          ))}
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}
