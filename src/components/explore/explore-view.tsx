"use client";

import { useMemo, useState } from "react";
import type { Dim } from "@/lib/explore/types";
import { dimColorFor, dimLabel } from "@/lib/explore/shape";
import type { ToolColors } from "@/lib/explore/shape";
import { parsePeriod, allTimePeriod, type Period } from "@/lib/explore/period";
import { buildExploreData, unpackScope, type PackedScope, type RawScope } from "@/lib/explore/build";
import { matchesVendorKey, parseVendorParam, vendorsInFacts, type VendorKey } from "@/lib/explore/vendor-filter";
import { cn } from "@/lib/utils";
import { Scorecards } from "./scorecards";
import { TrendChart } from "./trend-chart";
import { CompositionBreakdown } from "./composition-breakdown";
import { RankedPanel } from "./ranked-panel";
import { PeriodControl } from "./period-control";

/** Mirror state into a query param without a navigation/refetch. */
function syncParam(key: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  window.history.replaceState(null, "", url);
}

function Toggle({ dim, onChange, disabled }: { dim: Dim; onChange: (d: Dim) => void; disabled?: boolean }) {
  return (
    <div
      className={cn("inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs", disabled && "opacity-60")}
      title={disabled ? "Charts split by cost type while a vendor filter is active" : undefined}
    >
      {(["vendor", "cost_type"] as Dim[]).map((d) => (
        <button
          key={d}
          disabled={disabled}
          onClick={() => { onChange(d); syncParam("dim", d); }}
          className={cn("rounded px-2.5 py-1 transition-colors", dim === d ? "bg-accent/20 text-accent" : "text-muted", !disabled && dim !== d && "hover:text-foreground")}
        >
          {d === "vendor" ? "By vendor" : "By cost type"}
        </button>
      ))}
    </div>
  );
}

function VendorChips({
  vendors,
  active,
  onChange,
  toolColors,
}: {
  vendors: VendorKey[];
  active: VendorKey | "all";
  onChange: (v: VendorKey | "all") => void;
  toolColors: ToolColors;
}) {
  if (vendors.length < 2) return null; // a filter with one option is noise
  return (
    <div className="inline-flex flex-wrap items-center rounded-md border border-border bg-surface-2 p-0.5 text-xs">
      <button
        type="button"
        onClick={() => onChange("all")}
        className={cn("rounded px-2.5 py-1 transition-colors", active === "all" ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
      >
        All
      </button>
      {vendors.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(active === v ? "all" : v)}
          className={cn("flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors", active === v ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
        >
          <span className="size-2 rounded-full" style={{ background: dimColorFor("vendor", v, toolColors) }} />
          {dimLabel("vendor", v)}
        </button>
      ))}
    </div>
  );
}

export function ExploreView({
  scope: packedScope,
  initialPeriodParam,
  initialDim,
  initialVendorParam,
}: {
  scope: PackedScope;
  initialPeriodParam?: string;
  initialDim: Dim;
  initialVendorParam?: string;
}) {
  // Scopes cross the wire packed (string tables + tuples — ~70% smaller);
  // unpack ONCE, then everything below works on plain facts as before.
  const scope: RawScope = useMemo(() => unpackScope(packedScope), [packedScope]);
  const vendors = useMemo(() => vendorsInFacts(scope.facts), [scope.facts]);

  const [period, setPeriod] = useState<Period>(() =>
    // Explore defaults to the year view (drill-down links carry an explicit period).
    initialPeriodParam === "all" ? allTimePeriod(scope.earliest, new Date()) : parsePeriod(initialPeriodParam, new Date(), "year"),
  );
  const [dim, setDim] = useState<Dim>(initialDim);
  const [vendor, setVendor] = useState<VendorKey | "all">(() => parseVendorParam(initialVendorParam, vendors));

  // Vendor filter slices upstream of the shapers, so every panel (including
  // total-to-date) is vendor-scoped. Pure, in-memory — no network round-trip.
  const facts = useMemo(
    () => (vendor === "all" ? scope.facts : scope.facts.filter((f) => matchesVendorKey(f, vendor))),
    [scope.facts, vendor],
  );
  const data = useMemo(() => buildExploreData({ ...scope, facts }, period), [scope, facts, period]);

  // The projected tile only makes sense for a period with an end to project
  // to that includes today — so not All time, and not past periods. (The
  // trend projection self-gates: it's [] except on year/all charts.)
  const showProjection = useMemo(() => {
    if (period.granularity === "all") return false;
    const today = new Date().toISOString().slice(0, 10);
    return period.from <= today && today < period.toExclusive;
  }, [period]);

  // A single-vendor "by vendor" chart is one flat color — show cost type
  // instead. `dim` is preserved and restored when the filter clears.
  const effectiveDim: Dim = vendor === "all" ? dim : "cost_type";

  const changePeriod = (p: Period) => { setPeriod(p); syncParam("period", p.anchor); };
  const changeVendor = (v: VendorKey | "all") => { setVendor(v); syncParam("vendor", v === "all" ? null : v); };

  // Drill-down links keep the current period/dim/vendor context.
  const linkQuery = useMemo(() => {
    const q = new URLSearchParams({ period: period.anchor, dim });
    if (vendor !== "all") q.set("vendor", vendor);
    return q.toString();
  }, [period.anchor, dim, vendor]);

  return (
    <div className="space-y-6">
      <PeriodControl period={period} earliest={scope.earliest} onChange={changePeriod} />

      {/* Filter row: fixed composition — the toggle dims instead of unmounting,
          so nothing shifts when a vendor is (de)selected. */}
      <div className="flex flex-wrap items-center gap-4">
        <VendorChips vendors={vendors} active={vendor} onChange={changeVendor} toolColors={scope.toolColors} />
        <div className="ml-auto">
          <Toggle dim={effectiveDim} onChange={setDim} disabled={vendor !== "all"} />
        </div>
      </div>

      <Scorecards
        totalToDate={data.totalToDate}
        sc={data.scorecard}
        periodLabel={data.period.label}
        projection={showProjection ? data.projection.periodEnd : null}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* flex-col + flex-1 so the chart fills the card — the grid stretches
            this card to its neighbor's height, and a fixed-height chart left
            a squashed plot above dead space. */}
        <section className="flex flex-col rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium">Trend · {data.period.label}</h2>
          <div className="min-h-[300px] flex-1">
            <TrendChart
              data={data.trend[effectiveDim]}
              dim={effectiveDim}
              toolColors={scope.toolColors}
              projection={data.projection.trend}
              height="100%"
            />
          </div>
        </section>

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium">Where it&rsquo;s going · {data.period.label}</h2>
          <CompositionBreakdown
            nodes={data.treemap[effectiveDim]}
            onSelect={effectiveDim === "vendor" ? (key) => (key.startsWith("__") ? undefined : changeVendor(key as VendorKey)) : undefined}
          />
        </section>
      </div>

      <RankedPanel ranked={data.ranked} allStaff={data.allStaff} dim={effectiveDim} linkQuery={linkQuery} />
    </div>
  );
}
