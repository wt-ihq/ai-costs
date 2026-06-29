"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import type { Dim, RankRow } from "@/lib/explore/types";
import { dimColor } from "@/lib/explore/shape";
import { formatUsd, cn } from "@/lib/utils";

/** The color-coded spend split for one row, sized to total/max. */
function SplitBar({ r, dim, pct }: { r: RankRow; dim: Dim; pct: number }) {
  const segs = r.segments?.[dim] ?? [];
  // No breakdown (e.g. $0 roster row) → fall back to the plain accent fill.
  if (!segs.length || r.total <= 0) {
    return <div className="absolute inset-y-0 left-0 bg-accent/10" style={{ width: `${pct}%` }} aria-hidden />;
  }
  return (
    <div className="absolute inset-y-0 left-0 flex overflow-hidden opacity-30" style={{ width: `${pct}%` }} aria-hidden>
      {segs.map((s) => (
        <div key={s.key} style={{ width: `${(s.value / r.total) * 100}%`, background: dimColor(dim, s.key) }} />
      ))}
    </div>
  );
}

function Row({ r, max, i, dim }: { r: RankRow; max: number; i: number; dim: Dim }) {
  const reduce = useReducedMotion();
  const pct = max > 0 ? (r.total / max) * 100 : 0;
  const body = (
    <motion.div
      initial={reduce ? false : { opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.15, delay: Math.min(i, 20) * 0.015 }}
      className={cn("group relative flex items-center justify-between gap-4 overflow-hidden rounded-lg border border-border/60 bg-surface px-4 py-3 transition-colors", r.href && "hover:border-accent/60 hover:bg-surface-2")}
    >
      <SplitBar r={r} dim={dim} pct={pct} />
      <div className="relative min-w-0">
        <div className="truncate text-sm font-medium">
          {r.label}
          {r.idle && <span className="ml-2 rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-pink-300">idle seat</span>}
        </div>
        {r.sub && <div className="truncate text-xs text-muted">{r.sub}</div>}
      </div>
      <div className="relative shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">{formatUsd(r.total)}</div>
        {r.perHead != null && <div className="text-xs text-muted">{formatUsd(r.perHead)}/head</div>}
      </div>
    </motion.div>
  );
  return r.href ? <Link href={r.href} className="block">{body}</Link> : body;
}

export function RankedList({ rows, dim }: { rows: RankRow[]; dim: Dim }) {
  if (!rows.length) return <p className="text-sm text-muted">No spend in this period.</p>;
  const max = Math.max(...rows.map((r) => r.total), 0);
  return <div className="space-y-2">{rows.map((r, i) => <Row key={r.id} r={r} max={max} i={i} dim={dim} />)}</div>;
}
