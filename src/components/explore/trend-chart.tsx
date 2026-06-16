"use client";

import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Dim, TrendPoint } from "@/lib/explore/types";
import type { Vendor, CostType } from "@/lib/types";
import { VENDOR_COLORS, COST_TYPE_COLORS } from "@/lib/colors";
import { VENDOR_LABEL } from "@/lib/types";
import { formatUsd } from "@/lib/utils";

const AXIS = { stroke: "#8b92a5", fontSize: 11 };
const usd = (v: unknown) => formatUsd(Number(v));

export function TrendChart({ data, series, dim, height = 280 }: { data: TrendPoint[]; series: string[]; dim: Dim; height?: number }) {
  const color = (k: string) => (dim === "vendor" ? VENDOR_COLORS[k as Vendor] ?? "#6ea8fe" : COST_TYPE_COLORS[k as CostType] ?? "#6ea8fe");
  const label = (k: string) => (dim === "vendor" ? VENDOR_LABEL[k as Vendor] ?? k : k);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
        <XAxis dataKey="label" tickLine={false} axisLine={false} {...AXIS} />
        <YAxis tickFormatter={(v) => `$${(Number(v) / 1000).toFixed(0)}k`} tickLine={false} axisLine={false} width={44} {...AXIS} />
        <Tooltip
          contentStyle={{ background: "#14171f", border: "1px solid #262b38", borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: "#e6e8ee" }}
          itemStyle={{ padding: 0 }}
          cursor={{ fill: "#ffffff0a" }}
          formatter={usd}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
        {series.map((k) => (
          <Bar key={k} dataKey={k} name={label(k)} stackId="1" fill={color(k)} radius={[2, 2, 0, 0]} maxBarSize={48} isAnimationActive />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
