"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Vendor } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { VENDOR_LABEL } from "@/lib/types";
import { formatUsd } from "@/lib/utils";

const AXIS = { stroke: "#8b92a5", fontSize: 11 };
const tooltip = {
  contentStyle: {
    background: "#14171f",
    border: "1px solid #262b38",
    borderRadius: 8,
    fontSize: 12,
  },
  labelStyle: { color: "#e6e8ee" },
};
const usdFormatter = (v: unknown) => formatUsd(Number(v));

export function TrendChart({
  data,
  vendors,
}: {
  data: Array<{ month: string } & Partial<Record<Vendor, number>>>;
  vendors: Vendor[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
        <XAxis dataKey="month" tickLine={false} axisLine={false} {...AXIS} />
        <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tickLine={false} axisLine={false} width={42} {...AXIS} />
        <Tooltip {...tooltip} formatter={usdFormatter} />
        {vendors.map((v) => (
          <Area
            key={v}
            type="monotone"
            dataKey={v}
            name={VENDOR_LABEL[v]}
            stackId="1"
            stroke={VENDOR_COLORS[v]}
            fill={VENDOR_COLORS[v]}
            fillOpacity={0.25}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function VendorDonut({ data }: { data: { source: Vendor; total: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Tooltip {...tooltip} formatter={usdFormatter} />
        <Pie data={data} dataKey="total" nameKey="source" innerRadius={55} outerRadius={85} paddingAngle={2}>
          {data.map((d) => (
            <Cell key={d.source} fill={VENDOR_COLORS[d.source]} stroke="transparent" />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

export function DepartmentBars({ data }: { data: { department: string; total: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
        <XAxis type="number" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tickLine={false} axisLine={false} {...AXIS} />
        <YAxis type="category" dataKey="department" width={120} tickLine={false} axisLine={false} {...AXIS} />
        <Tooltip {...tooltip} formatter={usdFormatter} cursor={{ fill: "#1b1f2a" }} />
        <Bar dataKey="total" fill="#6ea8fe" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
