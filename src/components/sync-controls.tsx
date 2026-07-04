"use client";

import { useState, useTransition } from "react";
import { triggerSync, backfillSync, type BackfillResult } from "@/app/(dashboard)/imports/actions";
import type { SyncOutcome } from "@/lib/ingest/run-all";
import { cn } from "@/lib/utils";

export function SyncControls() {
  const [results, setResults] = useState<Record<string, SyncOutcome> | null>(null);
  const [backfill, setBackfill] = useState<BackfillResult | null>(null);
  const [months, setMonths] = useState("3");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Catch action rejections: a dropped connection during a backfill must
  // report something, not silently leave the user guessing whether it ran.
  const onSync = () =>
    start(async () => {
      setBackfill(null);
      setError(null);
      try {
        setResults(await triggerSync());
      } catch (err) {
        setResults(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  const onBackfill = () =>
    start(async () => {
      setResults(null);
      setError(null);
      try {
        setBackfill(await backfillSync(Number(months) || 1));
      } catch (err) {
        setBackfill(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">
          Failed: {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          onClick={onSync}
          disabled={pending}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-accent disabled:opacity-40"
        >
          {pending ? "Syncing…" : "Run sync now"}
        </button>
        <span className="text-xs text-muted">Pulls all API sources (Okta, Cursor, Anthropic, OpenAI) for the last 7 days.</span>
      </div>

      {results && (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {Object.entries(results).map(([source, r]) => (
            <li key={source} className="flex items-center justify-between rounded-md border border-border bg-surface-2/40 px-3 py-1.5 text-sm">
              <span className="capitalize">{source}</span>
              {r.ok ? (
                <span className="text-emerald-300">{r.rowsWritten} rows</span>
              ) : (
                <span className="max-w-[60%] truncate text-pink-300" title={r.error}>{r.error}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-muted">
            Backfill
            <input
              value={months}
              onChange={(e) => setMonths(e.target.value)}
              className="w-16 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
            />
            months
          </label>
          <button
            onClick={onBackfill}
            disabled={pending}
            className="rounded-md border border-border px-3 py-1.5 text-muted hover:text-foreground disabled:opacity-40"
          >
            {pending ? "Backfilling…" : "Backfill metered sources"}
          </button>
        </div>
        {backfill && (
          <div className={cn("mt-2 rounded-md border px-3 py-2 text-sm", backfill.errors.length ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300")}>
            Backfilled {backfill.months} months · {backfill.written} rows
            {backfill.errors.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-amber-200/80">
                {backfill.errors.slice(0, 4).map((e, i) => <li key={i}>{e}</li>)}
                {backfill.errors.length > 4 && <li>…and {backfill.errors.length - 4} more</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
