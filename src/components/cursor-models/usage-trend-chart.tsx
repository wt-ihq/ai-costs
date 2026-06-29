"use client";

import { useMemo } from "react";
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { UsageTrendPoint } from "@/lib/cursor-models/shape";
import { modelColor } from "@/lib/cursor-models/shape";
import { formatCount, formatCountCompact } from "@/lib/utils";

const AXIS = { stroke: "#8b92a5", fontSize: 11 };

/** Stacked messages-per-model trend across the period's buckets. */
export function UsageTrendChart({ data, height = 280 }: { data: UsageTrendPoint[]; height?: number }) {
  // Series = every model that appears in any bucket, ordered by total desc.
  const series = useMemo(() => {
    const totals = new Map<string, number>();
    for (const p of data) {
      for (const [k, v] of Object.entries(p)) {
        if (k === "label" || typeof v !== "number") continue;
        totals.set(k, (totals.get(k) ?? 0) + v);
      }
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [data]);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={5} {...AXIS} />
        <YAxis tickFormatter={(v) => formatCountCompact(Number(v))} tickLine={false} axisLine={false} width={44} {...AXIS} />
        <Tooltip
          contentStyle={{ background: "#14171f", border: "1px solid #262b38", borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: "#e6e8ee" }}
          cursor={{ fill: "#ffffff0a" }}
          formatter={(v: unknown) => `${formatCount(Number(v))} msgs`}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
        {series.map((k) => (
          <Bar key={k} dataKey={k} name={k} stackId="1" fill={modelColor(k)} radius={[2, 2, 0, 0]} maxBarSize={48} isAnimationActive />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
