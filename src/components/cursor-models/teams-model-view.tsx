"use client";

import { useMemo, useState } from "react";
import { buildTopModelData, type TopModelRow } from "@/lib/cursor-models/top-model-shape";
import { allTimePeriod, parsePeriod, type Period } from "@/lib/explore/period";
import { PeriodControl } from "@/components/explore/period-control";
import { Panel } from "@/components/ui";
import { ModelBars } from "./model-bars";
import { modelColor } from "@/lib/cursor-models/shape";
import { formatCount } from "@/lib/utils";

export function TeamsModelView({ scope, initialPeriodParam }: { scope: { rows: TopModelRow[]; earliest: string }; initialPeriodParam?: string }) {
  const [period, setPeriod] = useState<Period>(() =>
    initialPeriodParam === "all" ? allTimePeriod(scope.earliest, new Date()) : parsePeriod(initialPeriodParam, new Date()),
  );
  const data = useMemo(() => buildTopModelData(scope, period), [scope, period]);

  const changePeriod = (p: Period) => {
    setPeriod(p);
    const url = new URL(window.location.href);
    url.searchParams.set("period", p.anchor);
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="space-y-6">
      <PeriodControl period={period} earliest={scope.earliest} onChange={changePeriod} />

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-4">
        <span className="rounded bg-surface-2 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">Teams plan</span>
        <p className="min-w-0 flex-1 text-sm text-muted">
          Showing each person&rsquo;s <span className="text-foreground">most-used model</span> (from daily usage). Full
          per-model <span className="text-foreground">message volume</span> requires Cursor Enterprise.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Active users</span>
          <span className="text-2xl font-semibold tabular-nums">{formatCount(data.activeUsers)}</span>
          <span className="text-xs text-muted">{data.period.label}</span>
        </Panel>
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Models in use</span>
          <span className="text-2xl font-semibold tabular-nums">{formatCount(data.modelCount)}</span>
          <span className="text-xs text-muted">as someone&rsquo;s primary</span>
        </Panel>
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Top model</span>
          <span className="truncate text-2xl font-semibold">{data.distribution[0]?.label ?? "—"}</span>
          <span className="text-xs text-muted">most people&rsquo;s primary</span>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">Primary model across the team · {data.period.label}</h2>
          <Panel>
            <ModelBars nodes={data.distribution} />
          </Panel>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">By person · {data.period.label}</h2>
          <Panel>
            {data.people.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted">No Cursor usage this period.</div>
            ) : (
              <ul className="space-y-1.5">
                {data.people.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate">{p.name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="size-2.5 rounded-full" style={{ background: modelColor(p.primaryModel) }} />
                      <span className="font-mono text-xs text-muted">{p.primaryModel}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>
      </div>
    </div>
  );
}
