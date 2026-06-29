"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import type { UsageRankRow } from "@/lib/cursor-models/shape";
import { cn, formatCount } from "@/lib/utils";

function RankedList({ rows }: { rows: UsageRankRow[] }) {
  const reduce = useReducedMotion();
  if (!rows.length) return <div className="py-8 text-center text-sm text-muted">No usage this period.</div>;
  const max = Math.max(...rows.map((r) => r.messages), 0);
  return (
    <ul className="space-y-1">
      {rows.map((r, i) => {
        const inner = (
          <>
            <span
              className="absolute inset-y-0 left-0 rounded-md bg-accent/10"
              style={{ width: `${max > 0 ? (r.messages / max) * 100 : 0}%` }}
            />
            <span className="relative flex min-w-0 flex-col">
              <span className="truncate font-medium">{r.label}</span>
              {r.sub && <span className="truncate text-xs text-muted">{r.sub}</span>}
            </span>
            <span className="relative shrink-0 tabular-nums">{formatCount(r.messages)}</span>
          </>
        );
        const base = "relative flex items-center justify-between gap-3 overflow-hidden rounded-md px-3 py-2 text-sm";
        return (
          <motion.li
            key={r.id}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: Math.min(i, 16) * 0.02 }}
          >
            {r.href ? (
              <Link href={r.href} className={cn(base, "transition-colors hover:bg-surface-2")}>
                {inner}
              </Link>
            ) : (
              <div className={base}>{inner}</div>
            )}
          </motion.li>
        );
      })}
    </ul>
  );
}

/** Tabbed People / Teams leaderboard by message volume. */
export function UsageRankedPanel({ people, teams }: { people: UsageRankRow[]; teams: UsageRankRow[] }) {
  const [tab, setTab] = useState<"people" | "teams">("people");
  const tabs: { k: "people" | "teams"; label: string }[] = [
    { k: "people", label: "People" },
    { k: "teams", label: "Teams" },
  ];
  return (
    <div>
      <div className="mb-3 inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
        {tabs.map(({ k, label }) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn("rounded px-2.5 py-1 transition-colors", tab === k ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>
      <RankedList rows={tab === "people" ? people : teams} />
    </div>
  );
}
