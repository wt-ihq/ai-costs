"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import type { Dim, RankRow } from "@/lib/explore/types";
import { dimLabel } from "@/lib/explore/shape";
import { formatUsd, cn } from "@/lib/utils";

function Row({ r, max, i, dim, linkQuery }: { r: RankRow; max: number; i: number; dim: Dim; linkQuery?: string }) {
  const reduce = useReducedMotion();
  const pct = max > 0 ? (r.total / max) * 100 : 0;
  const segs = r.segments?.[dim] ?? [];
  const body = (
    <motion.div
      initial={reduce ? false : { opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.15, delay: Math.min(i, 20) * 0.015 }}
      className={cn("group rounded-lg border border-border/60 bg-surface px-4 py-3 transition-colors", r.href && "hover:border-accent/60 hover:bg-surface-2")}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{r.label}</div>
          {r.sub && <div className="truncate text-xs text-muted">{r.sub}</div>}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold tabular-nums">{formatUsd(r.total)}</div>
          {r.perHead != null && <div className="text-xs text-muted">{formatUsd(r.perHead)}/head</div>}
        </div>
      </div>
      {/* Thin full-saturation split bar — same colors as the charts. Hover
          names each segment (the bar itself carries no labels). */}
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"
        title={segs.length > 0 ? segs.map((s) => `${dimLabel(dim, s.key)} ${formatUsd(s.value)}`).join(" · ") : undefined}
      >
        {r.total > 0 && (segs.length > 0 ? (
          <div className="flex h-full gap-0.5" style={{ width: `${pct}%` }}>
            {segs.map((s) => (
              <div
                key={s.key}
                className="h-full rounded-full"
                style={{ width: `${(s.value / r.total) * 100}%`, background: s.color }}
                title={`${dimLabel(dim, s.key)} · ${formatUsd(s.value)}`}
              />
            ))}
          </div>
        ) : (
          <div className="h-full rounded-full bg-accent/40" style={{ width: `${pct}%` }} />
        ))}
      </div>
    </motion.div>
  );
  const href = r.href && linkQuery ? `${r.href}?${linkQuery}` : r.href;
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

export function RankedList({ rows, dim, linkQuery }: { rows: RankRow[]; dim: Dim; linkQuery?: string }) {
  if (!rows.length) return <p className="text-sm text-muted">No spend in this period.</p>;
  const max = Math.max(...rows.map((r) => r.total), 0);
  return <div className="space-y-2">{rows.map((r, i) => <Row key={r.id} r={r} max={max} i={i} dim={dim} linkQuery={linkQuery} />)}</div>;
}
