"use client";

import { useState, useTransition } from "react";
import {
  previewClaudeRoster,
  commitClaudeRoster,
  type RosterPreview,
} from "@/app/(dashboard)/imports/actions";
import { formatUsd } from "@/lib/utils";

export function ClaudeRosterImport() {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<RosterPreview | null>(null);
  const [result, setResult] = useState<{ written: number; seats: number; attributed: number } | null>(null);
  const [pending, start] = useTransition();

  const onFile = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const onPreview = () =>
    start(async () => {
      setResult(null);
      setPreview(await previewClaudeRoster(text));
    });

  const onCommit = () =>
    start(async () => {
      if (!preview) return;
      setResult(await commitClaudeRoster(preview.rows, asOf));
      setPreview(null);
      setText("");
      setFileName(null);
    });

  return (
    <div className="space-y-3">
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
          Month as of
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <button
          onClick={onPreview}
          disabled={pending || !text.trim()}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-accent disabled:opacity-40"
        >
          {pending ? "Parsing…" : "Preview"}
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="…or paste the roster CSV here (Name,Email,Role,Status,Seat Tier)"
        className="w-full rounded-md border border-border bg-surface-2 p-3 font-mono text-xs outline-none focus:border-accent"
      />

      {result && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Imported {result.seats} seats — {result.attributed} matched to employees, {result.written} seat facts written.
        </p>
      )}

      {preview && (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {preview.rows.length} seats · {Object.entries(preview.byTier).map(([t, n]) => `${n} ${t}`).join(", ")} · {preview.matchedCount} matched
            {preview.errors.length > 0 && ` · ${preview.errors.length} errors`}
          </p>
          <div className="max-h-96 overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-medium">Member</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 text-right font-medium">Seat / mo</th>
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
                    <td className="px-3 py-2 capitalize text-muted">{r.seatType}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.priceUsd ? formatUsd(r.priceUsd) : "—"}</td>
                    <td className="px-3 py-2">
                      {r.matched ? (
                        <span className="text-emerald-300">{r.employeeName}</span>
                      ) : (
                        <span className="rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] uppercase text-pink-300">no employee</span>
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
            {pending ? "Committing…" : `Commit ${preview.rows.length} seats (${formatUsd(preview.totalUsd)}/mo)`}
          </button>
        </div>
      )}
    </div>
  );
}
