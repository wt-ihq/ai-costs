"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignUnmatched } from "@/app/(dashboard)/data-health/actions";
import type { UnmatchedEntity } from "@/lib/queries/data-health";
import { VENDOR_LABEL } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { formatUsd } from "@/lib/utils";

export function UnmatchedQueue({
  rows,
  employees,
}: {
  rows: UnmatchedEntity[];
  employees: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className="text-sm text-muted">Nothing unmatched — every spend row is attributed. 🎉</p>;
  }

  const assign = (r: UnmatchedEntity) => {
    const key = `${r.source}:${r.entityKey}`;
    const employeeId = selected[key];
    if (!employeeId) return;
    setBusy(key);
    setError(null);
    start(async () => {
      try {
        await assignUnmatched(r.source, r.entityKey, employeeId);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        // try/finally: a failed action must not leave the button stuck on "…".
        setBusy(null);
      }
    });
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      {error && (
        <p className="border-b border-border bg-pink-500/10 px-3 py-2 text-sm text-pink-300">
          Assignment failed: {error}
        </p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Entity</th>
            <th className="px-3 py-2 text-right font-medium">Spend</th>
            <th className="px-3 py-2 font-medium">Assign to employee</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = `${r.source}:${r.entityKey}`;
            return (
              <tr key={key} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-muted">
                    <span className="size-2 rounded-full" style={{ background: VENDOR_COLORS[r.source] }} />
                    {VENDOR_LABEL[r.source]}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{r.entityKey}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatUsd(r.total)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={selected[key] ?? ""}
                      onChange={(e) => setSelected((s) => ({ ...s, [key]: e.target.value }))}
                      className="rounded-md border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-accent"
                    >
                      <option value="">Select…</option>
                      {employees.map((e) => (
                        <option key={e.id} value={e.id}>{e.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => assign(r)}
                      disabled={pending || !selected[key]}
                      className="rounded-md border border-accent bg-accent/15 px-2.5 py-1 text-sm text-accent disabled:opacity-40"
                    >
                      {busy === key ? "…" : "Assign"}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
