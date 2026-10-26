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

/** A bordered surface card. `id` makes it a link target (e.g. Data → Imports' checklist). */
export function Panel({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "rounded-xl border border-border bg-surface p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}


/**
 * A labelled on/off switch: the label, then a sliding track and knob — the
 * shape people already read as "click me, it toggles". Hover brightens the
 * label; keyboard works as a button (Space/Enter).
 */
export function Switch({
  checked,
  onChange,
  label,
  title,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn("group inline-flex items-center gap-2 text-xs", checked ? "text-foreground" : "text-muted hover:text-foreground", className)}
    >
      <span>{label}</span>
      <span
        aria-hidden
        className={cn(
          "relative inline-block h-4 w-7 shrink-0 rounded-full border transition-colors",
          checked ? "border-accent bg-accent/70" : "border-border bg-surface-2 group-hover:border-muted",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-[11px] rounded-full bg-foreground shadow transition-transform",
            checked ? "translate-x-3" : "opacity-70",
          )}
        />
      </span>
    </button>
  );
}
