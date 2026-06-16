import { cn } from "@/lib/utils";

/** Page header with a title and optional subtitle. */
export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="mb-6">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
    </header>
  );
}

/** A bordered surface card. */
export function Panel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-surface p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}

/** A KPI scorecard (Overview). */
export function Scorecard({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: string;
}) {
  return (
    <Panel className="flex flex-col gap-2">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {delta && <span className="text-xs text-muted">{delta}</span>}
    </Panel>
  );
}

/** Placeholder for a panel whose data wiring is not built yet. */
export function AwaitingData({ note }: { note: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted">
      {note}
    </div>
  );
}
