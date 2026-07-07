"use client";

import { useMemo, useState } from "react";
import {
  buildPersonRows,
  buildPlatformRows,
  buildVendorTotals,
  type ApiPlatformsScope,
} from "@/lib/queries/api-platforms";
import { allTimePeriod, parsePeriod, type Period } from "@/lib/explore/period";
import { PeriodControl } from "@/components/explore/period-control";
import { Panel } from "@/components/ui";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { cn, formatUsd } from "@/lib/utils";

export function ApiPlatformsView({
  scope,
  initialPeriodParam,
  initialVendorParam,
}: {
  scope: ApiPlatformsScope;
  initialPeriodParam?: string;
  initialVendorParam?: string;
}) {
  // Vendors present anywhere in the scope — a stable tile set across periods.
  const vendors = useMemo(
    () =>
      [...new Set(scope.rows.map((r) => r.source))].sort((a, b) =>
        VENDOR_LABEL[a].localeCompare(VENDOR_LABEL[b]),
      ),
    [scope.rows],
  );

  const [period, setPeriod] = useState<Period>(() =>
    initialPeriodParam === "all" ? allTimePeriod(scope.earliest, new Date()) : parsePeriod(initialPeriodParam, new Date()),
  );
  // Unknown or absent ?vendor= behaves as All.
  const [vendor, setVendor] = useState<Vendor | "all">(() =>
    vendors.includes(initialVendorParam as Vendor) ? (initialVendorParam as Vendor) : "all",
  );

  const nameByKey = useMemo(() => new Map(scope.names), [scope.names]);
  const inPeriod = useMemo(
    () => scope.rows.filter((r) => r.day >= period.from && r.day < period.toExclusive),
    [scope.rows, period],
  );
  const totals = useMemo(() => buildVendorTotals(inPeriod), [inPeriod]);
  const grandTotal = useMemo(() => [...totals.values()].reduce((s, v) => s + v, 0), [totals]);
  const filtered = useMemo(
    () => (vendor === "all" ? inPeriod : inPeriod.filter((r) => r.source === vendor)),
    [inPeriod, vendor],
  );
  const entities = useMemo(() => buildPlatformRows(filtered, nameByKey), [filtered, nameByKey]);
  const people = useMemo(() => buildPersonRows(filtered), [filtered]);
  const peopleTotal = useMemo(() => people.reduce((s, p) => s + p.total, 0), [people]);

  const syncUrl = (mutate: (url: URL) => void) => {
    const url = new URL(window.location.href);
    mutate(url);
    window.history.replaceState(null, "", url);
  };
  const changePeriod = (p: Period) => {
    setPeriod(p);
    syncUrl((u) => u.searchParams.set("period", p.anchor));
  };
  // Clicking the active vendor tile clears the filter back to All.
  const changeVendor = (v: Vendor | "all") => {
    const next = v === vendor ? "all" : v;
    setVendor(next);
    syncUrl((u) => (next === "all" ? u.searchParams.delete("vendor") : u.searchParams.set("vendor", next)));
  };

  const tileClasses = (active: boolean) =>
    cn(
      "rounded-xl border bg-surface p-4 text-left transition-colors",
      active ? "border-accent" : "border-border hover:border-accent/40",
    );

  return (
    <div className="space-y-6">
      <PeriodControl period={period} earliest={scope.earliest} onChange={changePeriod} />

      {/* Vendor spend tiles double as the vendor filter. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <button type="button" onClick={() => changeVendor("all")} aria-pressed={vendor === "all"} className={tileClasses(vendor === "all")}>
          <span className="text-xs uppercase tracking-wide text-muted">All vendors</span>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{formatUsd(grandTotal)}</div>
        </button>
        {vendors.map((v) => (
          <button key={v} type="button" onClick={() => changeVendor(v)} aria-pressed={vendor === v} className={tileClasses(vendor === v)}>
            <span className="flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ background: VENDOR_COLORS[v] }} />
              <span className="text-xs uppercase tracking-wide text-muted">{VENDOR_LABEL[v]}</span>
            </span>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{formatUsd(totals.get(v) ?? 0)}</div>
          </button>
        ))}
      </div>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Spend by person · {period.label}</h2>
        <Panel>
          {people.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted">No metered spend in {period.label}.</div>
          ) : (
            <ul className="space-y-1.5">
              {people.map((p) => (
                <li key={p.name} className="flex items-center gap-3 text-sm">
                  <span className="w-48 shrink-0 truncate">{p.name}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${peopleTotal > 0 ? (p.total / peopleTotal) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right tabular-nums">{formatUsd(p.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

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
