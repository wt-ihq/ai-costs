"use client";

import { useState, useTransition } from "react";
import { setCursorServiceAccount } from "@/app/(dashboard)/imports/actions";
import { formatUsd } from "@/lib/utils";

export interface CursorServiceAccountRow {
  accountId: string; // "sa_…"
  label: string | null;
  department: string | null;
  last30Usd: number; // on-demand spend in the last 30 days
}

/** Name each Cursor service account and pick the team its spend counts toward (Data → Tools). */
export function CursorServiceAccounts({ accounts, departments }: { accounts: CursorServiceAccountRow[]; departments: string[] }) {
  const [values, setValues] = useState<Record<string, { label: string; department: string }>>(
    Object.fromEntries(accounts.map((a) => [a.accountId, { label: a.label ?? "", department: a.department ?? "" }])),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onSave = (a: CursorServiceAccountRow) =>
    start(async () => {
      setError(null);
      setSaved(null);
      try {
        const v = values[a.accountId];
        const { factsUpdated } = await setCursorServiceAccount(a.accountId, v.label || null, v.department || null);
        setSaved(`${v.label || a.accountId} → ${v.department || "Unattributed"}: ${factsUpdated} days of spend updated.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  if (accounts.length === 0) {
    return <p className="text-sm text-muted">No service accounts yet — they appear after a Cursor sync sees one.</p>;
  }

  const set = (id: string, patch: Partial<{ label: string; department: string }>) =>
    setValues((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

  return (
    <div className="space-y-3">
      <datalist id="cursor-sa-departments">
        {departments.map((d) => <option key={d} value={d} />)}
      </datalist>
      {error && <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>}
      {saved && <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{saved}</p>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Team</th>
              <th className="px-3 py-2 text-right font-medium">Last 30 days</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const v = values[a.accountId];
              const changed = v.label !== (a.label ?? "") || v.department !== (a.department ?? "");
              return (
                <tr key={a.accountId} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-muted" title={a.accountId}>{a.accountId.slice(0, 11)}…</td>
                  <td className="px-3 py-2">
                    <input
                      value={v.label} onChange={(e) => set(a.accountId, { label: e.target.value })} placeholder="e.g. Bugbot" maxLength={60}
                      aria-label={`Name for ${a.accountId}`}
                      className="w-40 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      list="cursor-sa-departments" value={v.department} onChange={(e) => set(a.accountId, { department: e.target.value })} placeholder="Unattributed"
                      aria-label={`Team for ${a.accountId}`}
                      className="w-48 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUsd(a.last30Usd)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={pending || !changed} onClick={() => onSave(a)}
                      className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-xs text-accent disabled:opacity-40"
                    >Save</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
