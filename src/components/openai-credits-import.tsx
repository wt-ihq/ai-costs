"use client";

import { useState, useTransition } from "react";
import {
  previewOpenAiCreditsImport,
  commitOpenAiCreditsImport,
  type OpenAiCreditsPreview,
  type OpenAiCreditsCommitResult,
} from "@/app/(dashboard)/imports/actions";
import { formatUsd, formatPeople } from "@/lib/utils";

export function OpenAiCreditsImport({
  importedThrough,
  defaultRate,
}: {
  importedThrough: string | null;
  defaultRate: number;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [rate, setRate] = useState(String(defaultRate));
  const [preview, setPreview] = useState<OpenAiCreditsPreview | null>(null);
  const [result, setResult] = useState<OpenAiCreditsCommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onFile = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

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
      setPreview(await previewOpenAiCreditsImport(text, Number(rate) || 0));
    });

  const onCommit = () =>
    run(async () => {
      if (!preview) return;
      setResult(await commitOpenAiCreditsImport(preview.facts, Number(rate) || 0, fileName));
      setPreview(null);
      setText("");
      setFileName(null);
    });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        {importedThrough ? (
          <>Data imported through <span className="font-medium text-foreground">{importedThrough}</span>. A fresh export should cover from before that date — overlaps are replaced, not double-counted.</>
        ) : (
          <>No credits data imported yet.</>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="cursor-pointer rounded-md border border-border bg-surface-2 px-3 py-1.5 text-muted hover:text-foreground">
          {fileName ?? "Choose CSV…"}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </label>
        <label className="flex items-center gap-2 text-muted">
          USD / credit
          <input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
          />
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
          Imported {result.written} facts covering {result.from} → {result.to} — {result.attributed} attributed, {result.queued} queued for review.
        </p>
      )}

      {preview && (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {preview.minDay} → {preview.maxDay} · {formatPeople(preview.users.length)} · {preview.modelCount} models ·{" "}
            {Math.round(preview.totalCredits).toLocaleString()} credits = {formatUsd(preview.totalUsd)} ·{" "}
            {preview.matchedCount} matched
            {preview.errors.length > 0 && ` · ${preview.errors.length} bad rows skipped`}
          </p>
          <div className="max-h-96 overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-medium">Person</th>
                  <th className="px-3 py-2 text-right font-medium">Credits</th>
                  <th className="px-3 py-2 text-right font-medium">USD</th>
                  <th className="px-3 py-2 font-medium">Employee</th>
                </tr>
              </thead>
              <tbody>
                {preview.users.map((u) => (
                  <tr key={u.email} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">
                      {u.name}
                      <div className="text-xs text-muted">{u.email}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{Math.round(u.credits).toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatUsd(u.usd)}</td>
                    <td className="px-3 py-2">
                      {u.matched ? (
                        <span className="text-emerald-300">{u.employeeName}</span>
                      ) : (
                        <span className="rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] uppercase text-pink-300">no employee</span>
                      )}
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
              {pending ? "Committing…" : `Commit ${preview.facts.length} facts (${formatUsd(preview.totalUsd)})`}
            </button>
            <span className="text-xs text-muted">
              Unmatched people import unattributed and surface in the Data Health queue.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
