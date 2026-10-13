"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addFormerUser, assignUnmatched } from "@/app/(dashboard)/data-health/actions";
import type { UnmatchedEntity } from "@/lib/queries/data-health";
import { VENDOR_LABEL } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { FORMER_USERS_TEAM } from "@/lib/former-users";
import { formatUsd } from "@/lib/utils";

const FORMER = "__former__";
const FIELD = "rounded-md border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-accent";

type FormerForm = { name: string; email: string; team: string; left: string };
const emptyForm = (entityKey = ""): FormerForm => ({
  name: "",
  email: entityKey.includes("@") ? entityKey.toLowerCase() : "",
  team: FORMER_USERS_TEAM,
  left: "",
});

export function UnmatchedQueue({
  rows,
  employees,
  departments,
}: {
  rows: UnmatchedEntity[];
  employees: { id: string; name: string }[];
  departments: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, FormerForm>>({});
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  if (rows.length === 0) {
    return <p className="text-sm text-muted">Nothing unmatched — every spend row is attributed. 🎉</p>;
  }

  const patchForm = (key: string, patch: Partial<FormerForm>) =>
    setForms((f) => ({ ...f, [key]: { ...(f[key] ?? emptyForm()), ...patch } }));

  const createFormer = (r: UnmatchedEntity) => {
    const key = `${r.source}:${r.entityKey}`;
    const f = forms[key] ?? emptyForm(r.entityKey);
    setBusy(key);
    setFormErrors((e) => ({ ...e, [key]: "" }));
    start(async () => {
      try {
        const res = await addFormerUser({ source: r.source, entityKey: r.entityKey, ...f });
        if (res.ok) router.refresh();
        else setFormErrors((e) => ({ ...e, [key]: res.error }));
      } catch (err) {
        setFormErrors((e) => ({ ...e, [key]: err instanceof Error ? err.message : String(err) }));
      } finally {
        setBusy(null);
      }
    });
  };

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
                      onChange={(e) => {
                        setSelected((s) => ({ ...s, [key]: e.target.value }));
                        if (e.target.value === FORMER) setForms((f) => (f[key] ? f : { ...f, [key]: emptyForm(r.entityKey) }));
                      }}
                      className="rounded-md border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-accent"
                    >
                      <option value="">Select…</option>
                      <option value={FORMER}>Former user…</option>
                      {employees.map((e) => (
                        <option key={e.id} value={e.id}>{e.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => assign(r)}
                      disabled={pending || !selected[key] || selected[key] === FORMER}
                      className="rounded-md border border-accent bg-accent/15 px-2.5 py-1 text-sm text-accent disabled:opacity-40"
                    >
                      {busy === key ? "…" : "Assign"}
                    </button>
                  </div>
                  {selected[key] === FORMER && (
                    <div className="mt-2 grid max-w-md gap-2 rounded-md border border-border bg-surface-2/40 p-2">
                      <input
                        placeholder="Name"
                        value={forms[key]?.name ?? ""}
                        onChange={(e) => patchForm(key, { name: e.target.value })}
                        className={FIELD}
                      />
                      <input
                        placeholder="Email"
                        type="email"
                        value={(forms[key] ?? emptyForm(r.entityKey)).email}
                        onChange={(e) => patchForm(key, { email: e.target.value })}
                        className={FIELD}
                      />
                      <label className="flex items-center gap-2 text-xs text-muted">
                        Team
                        <select
                          value={(forms[key] ?? emptyForm(r.entityKey)).team}
                          onChange={(e) => patchForm(key, { team: e.target.value })}
                          className={FIELD}
                        >
                          {departments.filter((d) => d !== FORMER_USERS_TEAM).map((d) => (
                            <option key={d} value={d}>{d}</option>
                          ))}
                          <option value={FORMER_USERS_TEAM}>{FORMER_USERS_TEAM}</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted">
                        Left (optional)
                        <input
                          type="month"
                          value={forms[key]?.left ?? ""}
                          onChange={(e) => patchForm(key, { left: e.target.value })}
                          className={FIELD}
                        />
                      </label>
                      {formErrors[key] && <p className="text-xs text-pink-300">{formErrors[key]}</p>}
                      <button
                        onClick={() => createFormer(r)}
                        disabled={pending}
                        className="w-fit rounded-md border border-accent bg-accent/15 px-2.5 py-1 text-sm text-accent disabled:opacity-40"
                      >
                        {busy === key ? "…" : "Create & assign"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
