"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Scorecard } from "@/lib/explore/types";
import { formatUsd } from "@/lib/utils";

function Delta({ current, prev }: { current: number; prev: number }) {
  if (prev === 0) return <span className="text-xs text-muted">no prior month</span>;
  const pct = ((current - prev) / prev) * 100;
  const up = pct >= 0;
  return <span className={up ? "text-xs text-pink-300" : "text-xs text-emerald-300"}>{up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% MoM</span>;
}

function Card({ label, value, delay, children }: { label: string; value: string; delay: number; children?: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay }}
      className="rounded-xl border border-border bg-surface p-5"
    >
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1">{children}</div>
    </motion.div>
  );
}

export function Scorecards({ sc }: { sc: Scorecard }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card label="Total this month" value={formatUsd(sc.total)} delay={0}><Delta current={sc.total} prev={sc.prevTotal} /></Card>
      <Card label="Seat" value={formatUsd(sc.seat)} delay={0.04} />
      <Card label="Overage" value={formatUsd(sc.overage)} delay={0.08} />
      <Card label="Metered" value={formatUsd(sc.metered)} delay={0.12} />
    </div>
  );
}
