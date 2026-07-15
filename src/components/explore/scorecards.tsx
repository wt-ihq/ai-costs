"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Scorecard } from "@/lib/explore/types";
import { formatUsd, cn } from "@/lib/utils";

function Card({ label, value, delay, hero }: { label: string; value: string; delay: number; hero?: boolean }) {
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
    </motion.div>
  );
}

export function Scorecards({ totalToDate, sc, periodLabel }: { totalToDate: number; sc: Scorecard; periodLabel: string }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
      <Card label="Total to date" value={formatUsd(totalToDate)} delay={0} hero />
      <Card label={periodLabel} value={formatUsd(sc.total)} delay={0.04} />
      <Card label="Seat" value={formatUsd(sc.seat)} delay={0.08} />
      <Card label="Subscription" value={formatUsd(sc.subscription)} delay={0.12} />
      <Card label="Overage" value={formatUsd(sc.overage)} delay={0.16} />
      <Card label="API" value={formatUsd(sc.metered)} delay={0.2} />
    </div>
  );
}
