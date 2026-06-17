"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { currentPeriod, stepPeriod, canStepBack, canStepForward, type Period, type Granularity } from "@/lib/explore/period";
import { cn } from "@/lib/utils";

const GRANS: { g: Granularity; label: string }[] = [
  { g: "month", label: "Month" },
  { g: "quarter", label: "Quarter" },
  { g: "year", label: "Year" },
];

/** Granularity segmented control + period stepper; navigates with ?period=. */
export function PeriodControl({ period, earliest }: { period: Period; earliest: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const now = new Date();

  const go = (anchor: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("period", anchor);
    router.push(`${pathname}?${p.toString()}`);
  };

  const back = canStepBack(period, earliest);
  const fwd = canStepForward(period);

  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
        {GRANS.map(({ g, label }) => (
          <button
            key={g}
            onClick={() => go(currentPeriod(g, now).anchor)}
            className={cn("rounded px-2.5 py-1 transition-colors", period.granularity === g ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-1 py-0.5 text-sm">
        <button
          disabled={!back}
          aria-label="Previous period"
          onClick={() => go(stepPeriod(period, -1, now).anchor)}
          className={cn("rounded px-1.5 py-0.5 transition-colors", back ? "hover:text-accent" : "cursor-not-allowed text-muted/40")}
        >
          ‹
        </button>
        <span className="min-w-[8rem] text-center tabular-nums">
          {period.label}
          {period.isCurrent && <span className="ml-1 text-xs text-muted">· to date</span>}
        </span>
        <button
          disabled={!fwd}
          aria-label="Next period"
          onClick={() => go(stepPeriod(period, 1, now).anchor)}
          className={cn("rounded px-1.5 py-0.5 transition-colors", fwd ? "hover:text-accent" : "cursor-not-allowed text-muted/40")}
        >
          ›
        </button>
      </div>
    </div>
  );
}
