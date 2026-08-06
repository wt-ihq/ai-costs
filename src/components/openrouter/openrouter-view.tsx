"use client";

import { useMemo, useState } from "react";
import { buildOpenRouterData, type OpenRouterScope } from "@/lib/openrouter/shape";
import { modelColor } from "@/lib/cursor-models/shape";
import { allTimePeriod, parsePeriod, type Period } from "@/lib/explore/period";
import { PeriodControl } from "@/components/explore/period-control";
import { Panel } from "@/components/ui";
import { ShowAllList } from "@/components/show-all-list";
import { SpendTrendChart } from "./spend-trend-chart";
import { formatCount, formatCountCompact, formatUsd } from "@/lib/utils";

export function OpenRouterView({
  scope,
  initialPeriodParam,
}: {
  scope: OpenRouterScope;
  initialPeriodParam?: string;
}) {
  const [period, setPeriod] = useState<Period>(() =>
    initialPeriodParam === "all" ? allTimePeriod(scope.earliest, new Date()) : parsePeriod(initialPeriodParam, new Date()),
  );
  const data = useMemo(() => buildOpenRouterData(scope, period), [scope, period]);

  const changePeriod = (p: Period) => {
    setPeriod(p);
    const url = new URL(window.location.href);
    url.searchParams.set("period", p.anchor);
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="space-y-6">
      <PeriodControl period={period} earliest={scope.earliest} onChange={changePeriod} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Spend</span>
          <span className="text-2xl font-semibold tabular-nums">{formatUsd(data.total)}</span>
          <span className="text-xs text-muted">{period.label}</span>
        </Panel>
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Tokens</span>
          <span className="text-2xl font-semibold tabular-nums">{formatCountCompact(data.tokens)}</span>
          <span className="text-xs text-muted">prompt + completion</span>
        </Panel>
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Requests</span>
          <span className="text-2xl font-semibold tabular-nums">{formatCount(data.requests)}</span>
          <span className="text-xs text-muted">{period.label}</span>
        </Panel>
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">People</span>
          <span className="text-2xl font-semibold tabular-nums">{formatCount(data.people)}</span>
          <span className="text-xs text-muted">members with usage</span>
        </Panel>
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Models in use</span>
          <span className="text-2xl font-semibold tabular-nums">{formatCount(data.modelCount)}</span>
          <span className="text-xs text-muted">{period.label}</span>
        </Panel>
        <Panel className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Top model</span>
          <span className="truncate text-2xl font-semibold" title={data.topModel ?? undefined}>{data.topModel ?? "—"}</span>
          <span className="text-xs text-muted">by spend</span>
        </Panel>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Spend over time · {period.label}</h2>
        <Panel>
          {data.total === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted">No OpenRouter spend in {period.label}.</div>
          ) : (
            <SpendTrendChart data={data.trend} />
          )}
        </Panel>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">By model · {period.label}</h2>
          <Panel>
            {data.byModel.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted">No OpenRouter usage in {period.label}.</div>
            ) : (
              <ShowAllList
                items={data.byModel}
                render={(m) => (
                  <li key={m.model} className="flex items-center gap-3 text-sm">
                    <span className="flex w-56 shrink-0 items-center gap-2">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: modelColor(m.model) }} />
                      <span className="truncate font-mono text-xs text-muted" title={m.model}>{m.model}</span>
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${data.total > 0 ? (m.cost / data.total) * 100 : 0}%`, background: modelColor(m.model) }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted" title="Tokens">
                      {formatCountCompact(m.tokens)}
                    </span>
                    <span className="w-20 shrink-0 text-right tabular-nums">{formatUsd(m.cost)}</span>
                  </li>
                )}
              />
            )}
          </Panel>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">By person · {period.label}</h2>
          <Panel>
            {data.byPerson.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted">No OpenRouter usage in {period.label}.</div>
            ) : (
              <ShowAllList
                items={data.byPerson}
                render={(p) => (
                  <li key={p.name} className="space-y-1 text-sm">
                    <div className="flex items-center gap-3">
                      <span className="flex w-56 shrink-0 items-center gap-2">
                        <span className="truncate" title={p.name}>{p.name}</span>
                        {p.kind === "workspace" && (
                          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted" title="Usage from a workspace-owned API key, attributed to the workspace's department">
                            workspace
                          </span>
                        )}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${data.total > 0 ? (p.cost / data.total) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted" title="Requests">
                        {formatCount(p.requests)} req
                      </span>
                      <span className="w-20 shrink-0 text-right tabular-nums">{formatUsd(p.cost)}</span>
                    </div>
                    {/* Per-user model split: top models by spend, tail summarized. */}
                    {p.models.length > 0 && (
                      <div className="truncate pl-0 font-mono text-[11px] text-muted/80">
                        {p.models.slice(0, 3).map((m, i) => (
                          <span key={m.model}>
                            {i > 0 && " · "}
                            <span style={{ color: modelColor(m.model) }}>●</span> {m.model} {formatUsd(m.cost)}
                          </span>
                        ))}
                        {p.models.length > 3 && ` · +${p.models.length - 3} more`}
                      </div>
                    )}
                  </li>
                )}
              />
            )}
          </Panel>
        </section>
      </div>
    </div>
  );
}
