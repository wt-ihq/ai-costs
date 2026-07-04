"use client";

import { motion, useReducedMotion } from "motion/react";
import type { TreemapNode } from "@/lib/explore/types";
import { formatUsd } from "@/lib/utils";

/**
 * Spend composition as labeled horizontal bars — readable even when one item
 * dominates (a treemap collapses to a single block in that case). Each row:
 * colored bar sized vs. the largest, with name, amount, and % of total.
 */
export function CompositionBreakdown({ nodes }: { nodes: TreemapNode[] }) {
  const reduce = useReducedMotion();
  if (!nodes.length) return <div className="flex h-40 items-center justify-center text-sm text-muted">No spend in this period.</div>;
  const total = nodes.reduce((s, n) => s + n.value, 0);
  const max = Math.max(...nodes.map((n) => n.value), 0);
  return (
    <div className="space-y-2.5">
      {nodes.map((n, i) => (
        <div key={n.key}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: n.color }} />
              <span className="truncate">{n.label}</span>
            </span>
            <span className="shrink-0 tabular-nums">
              {formatUsd(n.value)}
              <span className="ml-2 text-xs text-muted">{total > 0 ? `${((n.value / total) * 100).toFixed(0)}%` : ""}</span>
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <motion.div
              className="h-full rounded-full"
              style={{ background: n.color }}
              initial={reduce ? false : { width: 0 }}
              animate={{ width: `${max > 0 ? (n.value / max) * 100 : 0}%` }}
              transition={{ duration: 0.4, delay: Math.min(i, 12) * 0.03, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
