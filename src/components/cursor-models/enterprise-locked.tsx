import { Panel } from "@/components/ui";

/**
 * Shown on /cursor-models while the Cursor Analytics API is unavailable (it
 * requires a Cursor Enterprise plan — see CURSOR_ANALYTICS_ENABLED). A greyed,
 * non-interactive preview of the dashboard sits behind an "Enterprise only"
 * notice so the page reads as built-but-locked rather than broken.
 */
export function EnterpriseLocked() {
  return (
    <div className="relative">
      {/* Notice */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-4">
        <span className="rounded bg-surface-2 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">
          Enterprise only
        </span>
        <p className="min-w-0 flex-1 text-sm text-muted">
          Cursor model-usage analytics require a <span className="text-foreground">Cursor Enterprise</span> plan.
          Intent HQ&apos;s team isn&apos;t on Enterprise yet, so this data isn&apos;t available. The dashboard is built and
          ready — it populates automatically once the team is upgraded.
        </p>
      </div>

      {/* Greyed, non-interactive preview */}
      <div aria-hidden className="pointer-events-none select-none space-y-6 opacity-40 blur-[1px] grayscale">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {["Messages", "Active users", "Models used", "Top model"].map((label) => (
            <Panel key={label} className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
              <span className="text-2xl font-semibold tabular-nums">—</span>
            </Panel>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="h-64 rounded-xl border border-border bg-surface" />
          <div className="h-64 rounded-xl border border-border bg-surface" />
        </div>
        <div className="h-40 rounded-xl border border-border bg-surface" />
      </div>
    </div>
  );
}
