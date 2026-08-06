"use client";

import { useState, useTransition } from "react";
import { assignOpenRouterWorkspaceDepartment } from "@/app/(dashboard)/imports/actions";

export interface OpenRouterWorkspaceRow {
  workspaceId: string;
  name: string;
  department: string | null;
}

export function OpenRouterWorkspaces({ workspaces, departments }: { workspaces: OpenRouterWorkspaceRow[]; departments: string[] }) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(workspaces.map((w) => [w.workspaceId, w.department ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onSave = (w: OpenRouterWorkspaceRow) =>
    start(async () => {
      setError(null);
      setSaved(null);
      try {
        const value = values[w.workspaceId] ?? "";
        const { factsUpdated } = await assignOpenRouterWorkspaceDepartment(w.workspaceId, value || null);
        setSaved(`${w.name} → ${value || "Unattributed"} — ${factsUpdated} facts re-attributed.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  if (workspaces.length === 0) {
    return <p className="text-sm text-muted">No workspaces yet — they appear after the first OpenRouter sync.</p>;
  }

  return (
    <div className="space-y-3">
      <datalist id="openrouter-departments">
        {departments.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>

      {error && (
        <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>
      )}
      {saved && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{saved}</p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-3 py-2 font-medium">Workspace</th>
              <th className="px-3 py-2 font-medium">Department</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {workspaces.map((w) => (
              <tr key={w.workspaceId} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-2 font-medium">{w.name}</td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    list="openrouter-departments"
                    value={values[w.workspaceId] ?? ""}
                    onChange={(e) => setValues((prev) => ({ ...prev, [w.workspaceId]: e.target.value }))}
                    placeholder="Unattributed"
                    className="w-48 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => onSave(w)}
                    disabled={pending}
                    className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-xs text-accent disabled:opacity-40"
                  >
                    {pending ? "Saving…" : "Save"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
