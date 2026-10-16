import type { ChecklistItem, ImportChecklist as Checklist } from "@/lib/imports/checklist";

/** A vendor's colour dot (its colour is a plain CSS variable in globals.css). */
export function VendorDot({ vendor, size = 8 }: { vendor: ChecklistItem["vendor"]; size?: number }) {
  return <span aria-hidden="true" className="shrink-0 rounded-full" style={{ width: size, height: size, background: `var(--color-vendor-${vendor})` }} />;
}

function Check() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
  );
}

function Alert() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v6" /><path d="M12 16.5v.5" /></svg>
  );
}

function Tile({ item }: { item: ChecklistItem }) {
  return (
    <div className={item.done ? "flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3.5" : "flex flex-col gap-2 rounded-lg border border-amber-400/35 bg-amber-400/5 p-3.5"}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <VendorDot vendor={item.vendor} />
        {item.label}
      </div>
      <div className={item.done ? "flex items-center gap-1.5 text-sm text-emerald-300" : "flex items-center gap-1.5 text-sm text-amber-300"}>
        {item.done ? <Check /> : <Alert />}
        {item.status}
      </div>
      {item.detail && <div className="text-xs text-muted tabular-nums">{item.detail}</div>}
      <a href={`#${item.anchor}`} className="mt-auto text-xs text-accent hover:underline">{item.action} →</a>
    </div>
  );
}

/** The top of Data → Imports: this month's four manual tasks, then anything last month still needs. */
export function ImportChecklist({ checklist, asOf }: { checklist: Checklist; asOf: string }) {
  const { items, previous } = checklist;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{checklist.monthName} {checklist.month.slice(0, 4)} · what&apos;s due</h2>
        <span className="text-xs text-muted">As of {asOf}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((i) => <Tile key={i.key} item={i} />)}
      </div>
      {previous.outstanding.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <span className="text-emerald-300"><Check /></span>
          {previous.monthName} is complete.
        </p>
      ) : (
        <p className="text-xs text-muted">
          <span className="text-amber-300">{previous.monthName} still needs: </span>
          {previous.outstanding.map((i, n) => (
            <span key={i.key}>
              {n > 0 && " · "}
              <a href={`#${i.anchor}`} className="text-foreground hover:text-accent">{i.label}</a> ({i.status.charAt(0).toLowerCase() + i.status.slice(1)})
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
