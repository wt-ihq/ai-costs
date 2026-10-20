"use client";

import { useState, useTransition } from "react";
import { rebuildClaudeTeamSpend } from "@/app/(dashboard)/imports/actions";

/** Rebuild Claude Team's daily usage from every saved paste (Data → Sync). */
export function ClaudeRebuild() {
  const [result, setResult] = useState<{ months: number; written: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const onRebuild = () =>
    start(async () => {
      setResult(null);
      setError(null);
      try {
        setResult(await rebuildClaudeTeamSpend());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  return (
    <div className="space-y-3">
      <button onClick={onRebuild} disabled={pending} className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-sm text-accent disabled:opacity-40">
        {pending ? "Rebuilding…" : "Rebuild Claude Team spend"}
      </button>
      {error && <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>}
      {result && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Rebuilt {result.months} {result.months === 1 ? "month" : "months"}: {result.written} daily rows.
        </p>
      )}
    </div>
  );
}
