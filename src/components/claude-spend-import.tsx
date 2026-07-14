"use client";

import { useState, useTransition } from "react";
import {
  previewClaudeSpendImport,
  commitClaudeSpendImport,
  type ClaudePreview,
  type ImportCommitResult,
} from "@/app/(dashboard)/imports/actions";
import { formatUsd, cn, localDateISO } from "@/lib/utils";

const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ClaudeSpendImport() {
  const [text, setText] = useState("");
  const [rate, setRate] = useState("1.27");
  const [asOf, setAsOf] = useState(() => localDateISO());
  const [preview, setPreview] = useState<ClaudePreview | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
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
      setPreview(await previewClaudeSpendImport(text, Number(rate) || 0));
    });

  const onCommit = () =>
    run(async () => {
      if (!preview) return;
      setResult(await commitClaudeSpendImport(preview.rows, asOf));
      setPreview(null);
      setText("");
    });

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder="Paste the Claude 'MTD spend' table here (Name / email / – £x.xx per member)…"
        className="w-full rounded-md border border-border bg-surface-2 p-3 font-mono text-xs outline-none focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          GBP → USD
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
          Imported {result.written} rows — {result.attributed} attributed, {result.queued} queued.
        </p>
      )}

      {preview && (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {preview.rows.length} members with spend ({preview.zeroCount} at £0 skipped),
            {" "}{preview.matchedCount} matched to employees.
            {preview.errors.length > 0 && ` ${preview.errors.length} parse errors.`}
          </p>
          <div className="max-h-96 overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-medium">Member</th>
                  <th className="px-3 py-2 text-right font-medium">MTD (£)</th>
                  <th className="px-3 py-2 text-right font-medium">USD</th>
                  <th className="px-3 py-2 font-medium">Employee</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.email} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">
                      {r.name}
                      <div className="text-xs text-muted">{r.email}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{gbp(r.mtdGbp)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatUsd(r.usd)}</td>
                    <td className="px-3 py-2">
                      {r.matched ? (
                        <span className="text-emerald-300">{r.employeeName}</span>
                      ) : (
                        <span className={cn("rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] uppercase text-pink-300")}>
                          unmatched → queue
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            onClick={onCommit}
            disabled={pending}
            className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-300 disabled:opacity-40"
          >
            {pending ? "Committing…" : `Commit import (${formatUsd(preview.totalUsd)})`}
          </button>
        </div>
      )}
    </div>
  );
}
