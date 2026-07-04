"use client";

import { useMemo, useState } from "react";
import { buildModelUsage, type ModelUsageRow } from "@/lib/cursor-models/shape";
import { allTimePeriod, parsePeriod, type Period } from "@/lib/explore/period";
import { PeriodControl } from "@/components/explore/period-control";
import { Panel } from "@/components/ui";
import { formatCount } from "@/lib/utils";
import { UsageTrendChart } from "./usage-trend-chart";
import { ModelBars } from "./model-bars";
import { UsageRankedPanel } from "./usage-ranked-panel";

interface Scope {
  rows: ModelUsageRow[];
  earliest: string;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Panel className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="truncate text-xs text-muted">{hint}</span>}
    </Panel>
  );
}

export function CursorModelsView({ scope, initialPeriodParam }: { scope: Scope; initialPeriodParam?: string }) {
  const [period, setPeriod] = useState<Period>(() =>
    initialPeriodParam === "all" ? allTimePeriod(scope.earliest, new Date()) : parsePeriod(initialPeriodParam, new Date()),
  );

  const data = useMemo(() => buildModelUsage(scope, period), [scope, period]);
  const { summary } = data;

  const changePeriod = (p: Period) => {
    setPeriod(p);
    const url = new URL(window.location.href);
    url.searchParams.set("period", p.anchor);
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <PeriodControl period={period} earliest={scope.earliest} onChange={changePeriod} />
      </div>

      {/* Plain grid: the StatCards are not motion components, so the previous
          staggerChildren variants were a silent no-op. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Messages" value={formatCount(summary.messages)} hint={`${data.period.label}`} />
        <StatCard label="Active users" value={formatCount(summary.activeUsers)} hint="with Cursor usage" />
        <StatCard label="Models used" value={formatCount(summary.modelCount)} />
        <StatCard label="Top model" value={summary.topModel ?? "—"} hint="by messages" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">Messages over time · {data.period.label}</h2>
          <Panel>
            <UsageTrendChart data={data.trend} />
          </Panel>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">Model mix · {data.period.label}</h2>
          <Panel>
            <ModelBars nodes={data.composition} />
          </Panel>
        </section>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Who&apos;s using it · {data.period.label}</h2>
        <Panel>
          <UsageRankedPanel people={data.people} teams={data.teams} />
        </Panel>
      </section>
    </div>
  );
}
