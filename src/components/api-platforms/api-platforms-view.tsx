"use client";

import { useMemo, useState } from "react";
import { buildPlatformRows, type ApiPlatformsScope } from "@/lib/queries/api-platforms";
import { allTimePeriod, parsePeriod, type Period } from "@/lib/explore/period";
import { PeriodControl } from "@/components/explore/period-control";
import { Panel } from "@/components/ui";
import { VENDOR_LABEL } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { formatUsd } from "@/lib/utils";

export function ApiPlatformsView({ scope, initialPeriodParam }: { scope: ApiPlatformsScope; initialPeriodParam?: string }) {
  const [period, setPeriod] = useState<Period>(() =>
    initialPeriodParam === "all" ? allTimePeriod(scope.earliest, new Date()) : parsePeriod(initialPeriodParam, new Date()),
  );

  const nameByKey = useMemo(() => new Map(scope.names), [scope.names]);
  const entities = useMemo(() => {
    const inPeriod = scope.rows.filter((r) => r.day >= period.from && r.day < period.toExclusive);
    return buildPlatformRows(inPeriod, nameByKey);
  }, [scope.rows, nameByKey, period]);

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
        <span className="text-sm text-muted">{period.label}</span>
      </div>

      {entities.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted">No metered spend in {period.label}.</p>
        </Panel>
      ) : (
        <div className="grid gap-4">
          {entities.map((e) => (
            <Panel key={`${e.source}:${e.entityKey}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full" style={{ background: VENDOR_COLORS[e.source] }} />
                    <span className="text-xs uppercase tracking-wide text-muted">{VENDOR_LABEL[e.source]}</span>
                  </div>
                  <h2 className="mt-1 font-medium">{e.name}</h2>
                  <p className="text-xs text-muted">
                    {e.entityKey}
                    {e.owner ? ` · owner ${e.owner}` : " · unattributed"}
                  </p>
                </div>
                <span className="text-lg font-semibold tabular-nums">{formatUsd(e.total)}</span>
              </div>

              <div className="mt-4 space-y-1.5">
                {e.models.map((m) => (
                  <div key={m.model} className="flex items-center gap-3 text-sm">
                    <span className="w-48 shrink-0 truncate font-mono text-xs text-muted">{m.model || "(no model)"}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${e.total > 0 ? (m.cost / e.total) * 100 : 0}%`, background: VENDOR_COLORS[e.source] }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right tabular-nums">{formatUsd(m.cost)}</span>
                  </div>
                ))}
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
