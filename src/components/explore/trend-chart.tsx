"use client";

import { useMemo } from "react";
import { Area, Bar, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Dim, TrendPoint } from "@/lib/explore/types";
import { dimColorFor, dimLabel, seriesOrder } from "@/lib/explore/shape";
import type { ToolColors } from "@/lib/explore/shape";
import { formatUsd } from "@/lib/utils";

const AXIS = { stroke: "#8b92a5", fontSize: 11 };

/**
 * Y-axis tick: adaptive units. Person pages chart tens of dollars, where a
 * fixed `$Xk` formatter rendered every tick as "$0k".
 */
const usdTick = (v: unknown) => {
  const n = Number(v);
  if (Math.abs(n) >= 1000) {
    const k = n / 1000;
    // One decimal when the tick isn't a whole number of k ($7.5k), else none.
    return `$${k.toFixed(Number.isInteger(k) || Math.abs(n) >= 10_000 ? 0 : 1)}k`;
  }
  return `$${Math.round(n)}`;
};

/**
 * Tight y-axis: Recharts' auto ticks round the top up aggressively (a $43k
 * max became a $60k axis — a third of the plot as headroom). Instead pick
 * the smallest "nice" tick step whose 4 steps clear the data max, and hand
 * the axis explicit ticks.
 */
const NICE_MANTISSAS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10];
function yAxisScale(points: TrendPoint[]): { top: number; ticks: number[] } {
  let max = 0;
  for (const p of points) {
    let stacked = 0;
    for (const [k, v] of Object.entries(p)) {
      if (k === "label") continue;
      if (Array.isArray(v)) max = Math.max(max, v[1]); // projectedRange [low, high]
      else if (typeof v === "number" && k === "projected") max = Math.max(max, v);
      else if (typeof v === "number") stacked += v; // bar segments stack
    }
    max = Math.max(max, stacked);
  }
  if (max <= 0) return { top: 4, ticks: [0, 1, 2, 3, 4] };
  const target = (max * 1.04) / 4; // ~4% headroom over the tallest point
  const pow = 10 ** Math.floor(Math.log10(target));
  const step = (NICE_MANTISSAS.find((m) => m * pow >= target) ?? 10) * pow;
  return { top: step * 4, ticks: [0, step, step * 2, step * 3, step * 4] };
}

type TooltipEntry = { dataKey?: string | number; name?: string; value?: number | string; color?: string; stroke?: string };

/** Recharts default tooltip plus a total in the header. The projected line is
 * excluded from the total (it IS a total, not a component) unless it's the
 * only value in the bucket. */
function TotalTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: string | number }) {
  if (!active || !payload?.length) return null;
  // The range band is drawn, not itemized — its [low, high] shows as its own line.
  const entries = payload.filter((e) => e.dataKey !== "projectedRange");
  const range = payload.find((e) => e.dataKey === "projectedRange")?.value as unknown as [number, number] | undefined;
  const actual = entries
    .filter((e) => e.dataKey !== "projected")
    .reduce((s, e) => s + (typeof e.value === "number" ? e.value : 0), 0);
  const projected = entries.find((e) => e.dataKey === "projected");
  const total = actual > 0 || !projected ? actual : Number(projected.value);
  return (
    <div style={{ background: "#14171f", border: "1px solid #262b38", borderRadius: 8, fontSize: 12, padding: "8px 12px" }}>
      <div style={{ color: "#e6e8ee", marginBottom: 4 }}>
        {label} · {formatUsd(total)}
      </div>
      {entries.map((e) => (
        <div key={String(e.dataKey)} style={{ color: e.color ?? e.stroke, padding: "1.5px 0" }}>
          {e.name} : {formatUsd(Number(e.value))}
        </div>
      ))}
      {range && (
        <div style={{ color: "#8b92a5", padding: "1.5px 0" }}>
          range : {formatUsd(range[0])} – {formatUsd(range[1])}
        </div>
      )}
    </div>
  );
}

export function TrendChart({
  data,
  dim,
  height = 280,
  toolColors,
  projection,
}: {
  data: TrendPoint[];
  dim: Dim;
  height?: number | `${number}%`;
  toolColors?: ToolColors;
  /** Forward month buckets carrying only a `projected` key. Points whose label
   * matches an existing bucket merge into it (year view enumerates the whole
   * year, so Aug–Dec already exist); the rest append (all-time view). */
  projection?: TrendPoint[];
}) {
  const points = useMemo(() => {
    if (!projection?.length) return data;
    const index = new Map(data.map((p, i) => [p.label, i]));
    const out = data.map((p) => ({ ...p }));
    for (const pr of projection) {
      const i = index.get(pr.label);
      if (i === undefined) out.push(pr);
      else out[i] = { ...out[i], ...pr, label: out[i].label };
    }
    return out;
  }, [data, projection]);

  // Stacked series from ALL the data points (every dim value that appears in
  // any bucket): vendors by total desc, cost types canonical (seat at the base).
  // `projected` is drawn as its own dashed line, never as a bar.
  const series = useMemo(() => seriesOrder(points, dim).filter((k) => k !== "projected"), [points, dim]);
  const yScale = useMemo(() => yAxisScale(points), [points]);

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
        <YAxis domain={[0, yScale.top]} ticks={yScale.ticks} tickFormatter={usdTick} tickLine={false} axisLine={false} width={44} {...AXIS} />
        <Tooltip content={<TotalTooltip />} cursor={{ fill: "#ffffff0a" }} />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
        {series.map((k) => (
          <Bar key={k} dataKey={k} name={label(k)} stackId="1" fill={color(k)} radius={[2, 2, 0, 0]} maxBarSize={48} isAnimationActive />
        ))}
        {projection && projection.length > 0 && (
          // Translucent low–high band behind the dashed line: the honest
          // spread between the model's conservative and aggressive readings.
          <Area
            dataKey="projectedRange"
            stroke="none"
            fill="#8b92a5"
            fillOpacity={0.12}
            legendType="none"
            activeDot={false}
            connectNulls={false}
            isAnimationActive
          />
        )}
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
