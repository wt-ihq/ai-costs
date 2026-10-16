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

