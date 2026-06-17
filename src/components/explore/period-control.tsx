"use client";

import { currentPeriod, allTimePeriod, stepPeriod, canStepBack, canStepForward, type Period, type Granularity } from "@/lib/explore/period";
import { cn } from "@/lib/utils";

const GRANS: { g: Granularity; label: string }[] = [
  { g: "month", label: "Month" },
  { g: "quarter", label: "Quarter" },
  { g: "year", label: "Year" },
  { g: "all", label: "All time" },
];

/** Granularity segmented control + period stepper. Updates client state instantly (no navigation). */
export function PeriodControl({ period, earliest, onChange }: { period: Period; earliest: string; onChange: (p: Period) => void }) {
  const now = new Date();
  const back = canStepBack(period, earliest);
  const fwd = canStepForward(period);

  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
        {GRANS.map(({ g, label }) => (
          <button
            key={g}
            type="button"
            onClick={() => onChange(g === "all" ? allTimePeriod(earliest, now) : currentPeriod(g, now))}
            className={cn("rounded px-2.5 py-1 transition-colors", period.granularity === g ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>
      {period.granularity === "all" ? (
        <div className="rounded-md border border-border bg-surface-2 px-3 py-1 text-sm">All time</div>
      ) : (
        <div className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-1 py-0.5 text-sm">
          <button
            type="button"
            disabled={!back}
            aria-label="Previous period"
            onClick={() => onChange(stepPeriod(period, -1, now))}
            className={cn("rounded px-1.5 py-0.5 transition-colors", back ? "hover:text-accent" : "cursor-not-allowed text-muted/40")}
          >
            ‹
          </button>
          <span className="min-w-[8rem] text-center tabular-nums">
            {period.label}
            {period.isCurrent && <span className="ml-1 text-xs text-muted">· to date</span>}
          </span>
          <button
            type="button"
            disabled={!fwd}
            aria-label="Next period"
            onClick={() => onChange(stepPeriod(period, 1, now))}
            className={cn("rounded px-1.5 py-0.5 transition-colors", fwd ? "hover:text-accent" : "cursor-not-allowed text-muted/40")}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
