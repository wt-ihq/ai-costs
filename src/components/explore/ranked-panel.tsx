"use client";

import { useState } from "react";
import type { Dim, ExploreData, RankRow } from "@/lib/explore/types";
import { RankedList } from "./ranked-list";
import { cn } from "@/lib/utils";

const TITLE: Record<ExploreData["ranked"]["kind"], string> = {
  team: "Teams", person: "People", lineitem: "Line items",
};

type Tab = "teams" | "people";

/**
 * Ranked breakdown. At company level (team rollup + full staff list both
 * present) it shows a Teams/People tabbed view; otherwise a single titled list.
 */
export function RankedPanel({ ranked, allStaff, dim, linkQuery }: { ranked: ExploreData["ranked"]; allStaff?: RankRow[]; dim: Dim; linkQuery?: string }) {
  const [tab, setTab] = useState<Tab>("teams");
  const tabbed = ranked.kind === "team" && !!allStaff;
  const rows = tabbed && tab === "people" ? allStaff! : ranked.rows;

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      {tabbed ? (
        <div className="mb-4 inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
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
        <h2 className="mb-4 text-sm font-medium">{TITLE[ranked.kind]}</h2>
      )}
      <RankedList rows={rows} dim={dim} linkQuery={linkQuery} />
      {/* Department-attributed recurring tools — their own list, never mixed
          in with people. */}
      {ranked.kind === "person" && (ranked.tools?.length ?? 0) > 0 && (
        <>
          <h2 className="mb-4 mt-6 text-sm font-medium">Tools</h2>
          <RankedList rows={ranked.tools!} dim={dim} linkQuery={linkQuery} />
        </>
      )}
    </section>
  );
}
