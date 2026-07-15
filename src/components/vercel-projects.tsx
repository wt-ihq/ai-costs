"use client";

import { useState, useTransition } from "react";
import { assignVercelProjectDepartment } from "@/app/(dashboard)/imports/actions";

export interface VercelProjectRow {
  projectId: string;
  projectName: string;
  department: string | null;
}

export function VercelProjects({ projects, departments }: { projects: VercelProjectRow[]; departments: string[] }) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(projects.map((p) => [p.projectId, p.department ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onSave = (p: VercelProjectRow) =>
    start(async () => {
      setError(null);
      setSaved(null);
      try {
        const value = values[p.projectId] ?? "";
        const { factsUpdated } = await assignVercelProjectDepartment(p.projectId, value || null);
        setSaved(`${p.projectName} → ${value || "Unattributed"} — ${factsUpdated} facts re-attributed.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  if (projects.length === 0) {
    return <p className="text-sm text-muted">No projects yet — they appear after the first Vercel sync.</p>;
  }

  return (
    <div className="space-y-3">
      <datalist id="vercel-departments">
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
              <th className="px-3 py-2 font-medium">Project</th>
              <th className="px-3 py-2 font-medium">Department</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.projectId} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-2 font-medium">{p.projectName}</td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    list="vercel-departments"
                    value={values[p.projectId] ?? ""}
                    onChange={(e) => setValues((prev) => ({ ...prev, [p.projectId]: e.target.value }))}
                    placeholder="Unattributed"
                    className="w-48 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => onSave(p)}
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
