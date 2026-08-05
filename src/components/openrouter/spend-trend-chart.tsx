"use client";

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SpendTrendPoint } from "@/lib/openrouter/shape";
import { VENDOR_COLORS } from "@/lib/colors";
import { formatUsd } from "@/lib/utils";

const AXIS = { stroke: "#8b92a5", fontSize: 11 };

/** Total spend per bucket (the shaper clips empty edge buckets); per-model detail lives in the By model list. */
export function SpendTrendChart({ data, height = 280 }: { data: SpendTrendPoint[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={5} {...AXIS} />
        <YAxis tickFormatter={(v) => formatUsd(Number(v))} tickLine={false} axisLine={false} width={56} {...AXIS} />
        <Tooltip
          contentStyle={{ background: "#14171f", border: "1px solid #262b38", borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: "#e6e8ee" }}
          cursor={{ fill: "#ffffff0a" }}
          formatter={(v: unknown) => [formatUsd(Number(v)), "Spend"]}
        />
        <Bar dataKey="total" name="Spend" fill={VENDOR_COLORS.openrouter} radius={[3, 3, 0, 0]} maxBarSize={64} isAnimationActive />
      </BarChart>
    </ResponsiveContainer>
  );
}
