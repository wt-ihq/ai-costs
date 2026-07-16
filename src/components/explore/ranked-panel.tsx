"use client";

import { useMemo, useState } from "react";
import type { Dim, ExploreData, RankRow } from "@/lib/explore/types";
import { RankedList } from "./ranked-list";
import { cn } from "@/lib/utils";

const TITLE: Record<ExploreData["ranked"]["kind"], string> = {
  team: "Teams", person: "People", lineitem: "Line items",
};

type Tab = "teams" | "people";
type Sort = "total" | "perHead";

/**
 * Ranked breakdown. At company level (team rollup + full staff list both
 * present) it shows a Teams/People tabbed view; otherwise a single titled list.
 */
export function RankedPanel({ ranked, allStaff, dim, linkQuery }: { ranked: ExploreData["ranked"]; allStaff?: RankRow[]; dim: Dim; linkQuery?: string }) {
  const [tab, setTab] = useState<Tab>("teams");
  const [sort, setSort] = useState<Sort>("total");
  const tabbed = ranked.kind === "team" && !!allStaff;
  const rows = tabbed && tab === "people" ? allStaff! : ranked.rows;

  // Cost/head sorting, where rows carry a per-head figure (teams). Rows
  // without one (Shared seats, Unattributed) sink to the bottom.
  const hasPerHead = rows.some((r) => r.perHead != null);
  const sorted = useMemo(
    () => (sort === "perHead" && hasPerHead ? [...rows].sort((a, b) => (b.perHead ?? -1) - (a.perHead ?? -1)) : rows),
    [rows, sort, hasPerHead],
  );

  const sortToggle = hasPerHead && (
    <div className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-muted">Sort</span>
      <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
        {([["total", "Total"], ["perHead", "$/head"]] as [Sort, string][]).map(([s, label]) => (
          <button
            key={s}
            type="button"
            onClick={() => setSort(s)}
            className={cn("rounded px-2.5 py-1 transition-colors", sort === s ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        {tabbed ? (
          <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
            {([["teams", "Teams"], ["people", "People"]] as [Tab, string][]).map(([t, label]) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn("rounded px-2.5 py-1 transition-colors", tab === t ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <h2 className="text-sm font-medium">{TITLE[ranked.kind]}</h2>
        )}
        {sortToggle}
      </div>
      <RankedList rows={sorted} dim={dim} linkQuery={linkQuery} />
      {/* Department-attributed recurring tools + Vercel projects — their own
          list, never mixed in with people. */}
      {ranked.kind === "person" && (ranked.tools?.length ?? 0) > 0 && (
        <>
          <h2 className="mb-4 mt-6 text-sm font-medium">Tools & infrastructure</h2>
          <RankedList rows={ranked.tools!} dim={dim} linkQuery={linkQuery} />
        </>
      )}
    </section>
  );
}
