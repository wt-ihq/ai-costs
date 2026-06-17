"use client";

import { useState } from "react";
import type { Dim, ExploreData } from "@/lib/explore/types";
import { cn } from "@/lib/utils";
import { Scorecards } from "./scorecards";
import { TrendChart } from "./trend-chart";
import { CompositionBreakdown } from "./composition-breakdown";
import { RankedList } from "./ranked-list";
import { PeriodControl } from "./period-control";

const RANK_TITLE: Record<ExploreData["ranked"]["kind"], string> = {
  team: "Teams", person: "People", lineitem: "Line items",
};

function Toggle({ dim, onChange }: { dim: Dim; onChange: (d: Dim) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
      {(["vendor", "cost_type"] as Dim[]).map((d) => (
        <button
          key={d}
          onClick={() => {
            onChange(d);
            const url = new URL(window.location.href);
            url.searchParams.set("dim", d);
            window.history.replaceState(null, "", url);
          }}
          className={cn("rounded px-2.5 py-1 transition-colors", dim === d ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
        >
          {d === "vendor" ? "By vendor" : "By cost type"}
        </button>
      ))}
    </div>
  );
}

export function ExploreView({ data, initialDim }: { data: ExploreData; initialDim: Dim }) {
  const [dim, setDim] = useState<Dim>(initialDim);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <PeriodControl period={data.period} earliest={data.earliest} />
        <Toggle dim={dim} onChange={setDim} />
      </div>

      <Scorecards totalToDate={data.totalToDate} sc={data.scorecard} periodLabel={data.period.label} />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium">Trend · {data.period.label}</h2>
          <TrendChart data={data.trend[dim]} dim={dim} />
        </section>

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium">Where it&rsquo;s going · {data.period.label}</h2>
          <CompositionBreakdown nodes={data.treemap[dim]} />
        </section>
      </div>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-4 text-sm font-medium">{RANK_TITLE[data.ranked.kind]}</h2>
        <RankedList rows={data.ranked.rows} />
      </section>
    </div>
  );
}
