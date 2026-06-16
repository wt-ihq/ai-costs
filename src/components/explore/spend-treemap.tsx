"use client";

import type { ComponentProps } from "react";
import { ResponsiveContainer, Tooltip, Treemap } from "recharts";
import type { TreemapNode } from "@/lib/explore/types";
import { formatUsd } from "@/lib/utils";

type TreemapData = ComponentProps<typeof Treemap>["data"];

interface CellProps { x?: number; y?: number; width?: number; height?: number; label?: string; color?: string; value?: number }
function Cell({ x = 0, y = 0, width = 0, height = 0, label, color, value }: CellProps) {
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={4} fill={color ?? "#6ea8fe"} fillOpacity={0.85} stroke="#0b0d12" strokeWidth={2} />
      {width > 70 && height > 28 && (
        <text x={x + 8} y={y + 20} fill="#0b0d12" fontSize={12} fontWeight={600}>
          {label}{value != null ? ` · ${formatUsd(value)}` : ""}
        </text>
      )}
    </g>
  );
}

export function SpendTreemap({ nodes, height = 240 }: { nodes: TreemapNode[]; height?: number }) {
  if (!nodes.length) return <div className="flex h-40 items-center justify-center text-sm text-muted">No spend this month.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <Treemap data={nodes as unknown as TreemapData} dataKey="value" nameKey="label" content={<Cell />} isAnimationActive>
        <Tooltip contentStyle={{ background: "#14171f", border: "1px solid #262b38", borderRadius: 8, fontSize: 12 }} formatter={(v: unknown) => formatUsd(Number(v))} />
      </Treemap>
    </ResponsiveContainer>
  );
}
