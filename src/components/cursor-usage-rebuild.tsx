"use client";

import { useState, useTransition } from "react";
import { rebuildCursorUsageMonth } from "@/app/(dashboard)/imports/actions";

/** Pick a month, rebuild its Cursor daily usage (Data → Sync). */
export function CursorUsageRebuild() {
  // The current month by default; the client's date, so the server render may differ by a day.
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [result, setResult] = useState<{ month: string; rows: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onRebuild = () =>
    start(async () => {
      setResult(null);
      setError(null);
      try {
        setResult(await rebuildCursorUsageMonth(month));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          Month
          <input
            type="month" value={month} onChange={(e) => setMonth(e.target.value)} suppressHydrationWarning
            className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
          />
        </label>
        <button
          onClick={onRebuild} disabled={pending || !month}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-accent disabled:opacity-40"
        >
          {pending ? "Rebuilding…" : "Rebuild"}
        </button>
      </div>
      {error && <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>}
      {result && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Rebuilt {result.month}: {result.rows} daily usage rows.
        </p>
      )}
    </div>
  );
}
