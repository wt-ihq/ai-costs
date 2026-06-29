"use client";

import { useMemo, useState } from "react";
import type { Dim } from "@/lib/explore/types";
import { parsePeriod, allTimePeriod, type Period } from "@/lib/explore/period";
import { buildExploreData, type RawScope } from "@/lib/explore/build";
import { cn } from "@/lib/utils";
import { Scorecards } from "./scorecards";
import { TrendChart } from "./trend-chart";
import { CompositionBreakdown } from "./composition-breakdown";
import { RankedPanel } from "./ranked-panel";
import { PeriodControl } from "./period-control";

/** Mirror state into a query param without a navigation/refetch. */
function syncParam(key: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  window.history.replaceState(null, "", url);
}

function Toggle({ dim, onChange }: { dim: Dim; onChange: (d: Dim) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
      {(["vendor", "cost_type"] as Dim[]).map((d) => (
        <button
          key={d}
          onClick={() => { onChange(d); syncParam("dim", d); }}
          className={cn("rounded px-2.5 py-1 transition-colors", dim === d ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
        >
          {d === "vendor" ? "By vendor" : "By cost type"}
        </button>
      ))}
    </div>
  );
}

export function ExploreView({ scope, initialPeriodParam, initialDim }: { scope: RawScope; initialPeriodParam?: string; initialDim: Dim }) {
  const [period, setPeriod] = useState<Period>(() =>
    initialPeriodParam === "all" ? allTimePeriod(scope.earliest, new Date()) : parsePeriod(initialPeriodParam, new Date()),
  );
  const [dim, setDim] = useState<Dim>(initialDim);

  // Pure, in-memory re-slice on every period change — no network round-trip.
  const data = useMemo(() => buildExploreData(scope, period), [scope, period]);

  const changePeriod = (p: Period) => { setPeriod(p); syncParam("period", p.anchor); };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <PeriodControl period={period} earliest={scope.earliest} onChange={changePeriod} />
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

      <RankedPanel ranked={data.ranked} allStaff={data.allStaff} dim={dim} />
    </div>
  );
}
