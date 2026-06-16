"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Scorecard } from "@/lib/explore/types";
import { formatUsd, cn } from "@/lib/utils";

function Delta({ current, prev }: { current: number; prev: number }) {
  if (prev === 0) return <span className="text-xs text-muted">no prior month</span>;
  const pct = ((current - prev) / prev) * 100;
  const up = pct >= 0;
  return <span className={up ? "text-xs text-pink-300" : "text-xs text-emerald-300"}>{up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% MoM</span>;
}

function Card({ label, value, delay, hero, children }: { label: string; value: string; delay: number; hero?: boolean; children?: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay }}
      className={cn("rounded-xl border p-5", hero ? "border-accent/40 bg-accent/5" : "border-border bg-surface")}
    >
      <div className={cn("text-xs uppercase tracking-wide", hero ? "text-accent" : "text-muted")}>{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1">{children}</div>
    </motion.div>
  );
}

export function Scorecards({ totalToDate, sc, month }: { totalToDate: number; sc: Scorecard; month: string }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Card label="Total to date" value={formatUsd(totalToDate)} delay={0} hero>
        <span className="text-xs text-muted">all spend on record</span>
      </Card>
      <Card label={month} value={formatUsd(sc.total)} delay={0.04}><Delta current={sc.total} prev={sc.prevTotal} /></Card>
      <Card label="Seat" value={formatUsd(sc.seat)} delay={0.08} />
      <Card label="Overage" value={formatUsd(sc.overage)} delay={0.12} />
      <Card label="API" value={formatUsd(sc.metered)} delay={0.16} />
    </div>
  );
}
