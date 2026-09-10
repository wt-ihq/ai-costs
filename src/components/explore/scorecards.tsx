"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Scorecard } from "@/lib/explore/types";
import type { PeriodProjection } from "@/lib/explore/project";
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

function ProjectedCard({ p, delay }: { p: PeriodProjection; delay: number }) {
  const reduce = useReducedMotion();
  const delta =
    p.deltaPct === null
      ? "no earlier data to compare"
      : `${p.deltaPct >= 0 ? "+" : ""}${p.deltaPct.toFixed(0)}% vs ${p.compareLabel}`;
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay }}
      // Dashed border: a projection must never read as an actual.
      className="rounded-xl border border-dashed border-border bg-surface p-5"
      title={p.basis === "previous-month" ? "Early-month estimate — based on last month's daily rate" : "Based on each source's recent daily pace and direction (seats & subscriptions counted exactly)"}
    >
      <div className="text-xs uppercase tracking-wide text-muted">Projected · {p.label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{formatUsd(p.projectedUsd)}</div>
      <div className="mt-1 text-xs text-muted">{delta}</div>
      {p.lowUsd !== p.highUsd && (
        <div className="mt-0.5 text-xs tabular-nums text-muted/80">
          {formatUsd(p.lowUsd)} – {formatUsd(p.highUsd)}
        </div>
      )}
    </motion.div>
  );
}

const ALL_TIME_LABEL = "All time";

// Tailwind needs literal class names — no interpolated `lg:grid-cols-${n}`.
const COLUMN_CLASS: Record<number, string> = {
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
  7: "lg:grid-cols-7",
};

export function Scorecards({
  totalToDate,
  sc,
  periodLabel,
  projection,
}: {
  totalToDate: number;
  sc: Scorecard;
  periodLabel: string;
  projection?: PeriodProjection | null;
}) {
  // On the All time period the second card would repeat the hero card verbatim
  // (same label, same total), so it collapses to one.
  const showPeriodCard = periodLabel !== ALL_TIME_LABEL;
  const columns = 5 + (showPeriodCard ? 1 : 0) + (projection ? 1 : 0);

  return (
    <div className={cn("grid grid-cols-2 gap-4", COLUMN_CLASS[columns])}>
      <Card label={ALL_TIME_LABEL} value={formatUsd(totalToDate)} delay={0} hero />
      {showPeriodCard && <Card label={periodLabel} value={formatUsd(sc.total)} delay={0.04} />}
      {projection && <ProjectedCard p={projection} delay={0.06} />}
      <Card label="Seat" value={formatUsd(sc.seat)} delay={0.08} />
      <Card label="Subscription" value={formatUsd(sc.subscription)} delay={0.12} />
      <Card label="Overage" value={formatUsd(sc.overage)} delay={0.16} />
      <Card label="API" value={formatUsd(sc.metered)} delay={0.2} />
    </div>
  );
}
