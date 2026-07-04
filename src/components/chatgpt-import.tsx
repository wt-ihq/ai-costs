"use client";

import { useState, useTransition } from "react";
import {
  previewChatGptImport,
  commitChatGptImport,
  type ChatGptPreview,
  type ChatGptCommitResult,
} from "@/app/(dashboard)/imports/actions";
import { formatUsd, cn, localDateISO } from "@/lib/utils";

const CONFIDENCE_STYLE = {
  high: "bg-emerald-500/15 text-emerald-300",
  low: "bg-amber-500/15 text-amber-300",
  none: "bg-pink-500/15 text-pink-300",
} as const;

export function ChatGptImport() {
  const [text, setText] = useState("");
  const [rate, setRate] = useState("0.01");
  const [asOf, setAsOf] = useState(() => localDateISO());
  const [preview, setPreview] = useState<ChatGptPreview | null>(null);
  const [result, setResult] = useState<ChatGptCommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  const onPreview = () =>
    run(async () => {
      setResult(null);
      setPreview(await previewChatGptImport(text, Number(rate) || 0));
    });

  const onCommit = () =>
    run(async () => {
      if (!preview) return;
      setResult(await commitChatGptImport(preview.rows, asOf));
      setPreview(null);
      setText("");
    });

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder="Paste the ChatGPT Workspace analytics table here (Name / Seat type / Credits spent / Messages sent)…"
        className="w-full rounded-md border border-border bg-surface-2 p-3 font-mono text-xs outline-none focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          USD / credit
          <input value={rate} onChange={(e) => setRate(e.target.value)} className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <label className="flex items-center gap-2 text-muted">
          Data as of
          {/* Default is the client's local date; the server-rendered value can differ by a day. */}
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} suppressHydrationWarning className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <button
          onClick={onPreview}
          disabled={pending || !text.trim()}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-accent disabled:opacity-40"
        >
          {pending ? "Parsing…" : "Preview"}
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">
          Failed: {error}
        </p>
      )}

      {result && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Imported {result.written} rows ({result.seats} seats) — {result.attributed} overage rows attributed, {result.queued} queued for review.
        </p>
      )}

      {preview && (
        <div className="space-y-3">
          {preview.errors.length > 0 && (
            <p className="text-xs text-amber-300">{preview.errors.length} rows could not be parsed.</p>
          )}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-medium">Member</th>
                  <th className="px-3 py-2 text-right font-medium">Credits</th>
                  <th className="px-3 py-2 text-right font-medium">USD</th>
                  <th className="px-3 py-2 font-medium">Matched employee</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{r.creditsSpent.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.usd ? formatUsd(r.usd) : "—"}</td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px] uppercase", CONFIDENCE_STYLE[r.confidence])}>
                          {r.confidence}
                        </span>
                        {r.employeeName ?? <span className="text-muted">unmatched → queue</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onCommit}
              disabled={pending}
              className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-300 disabled:opacity-40"
            >
              {pending ? "Committing…" : `Commit import (${formatUsd(preview.totalUsd)})`}
            </button>
            <span className="text-xs text-muted">
              Low/none-confidence rows import unattributed and surface in the Data Health queue.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
