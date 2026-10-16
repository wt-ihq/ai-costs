"use client";

import { useState, useTransition } from "react";
import { grantDashboardAccess, revokeDashboardAccess, setDashboardAccessRole } from "@/app/(dashboard)/data/access-actions";
import type { AccessRole } from "@/lib/dashboard-access";

export interface AccessPerson { email: string; name: string | null; team: string | null; left: boolean }
export interface AccessRowView extends AccessPerson { role: AccessRole; addedBy: string; addedAt: string }

const ROLE_LABEL: Record<AccessRole, string> = { viewer: "Viewer", admin: "Admin" };
const selectCls = "rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-foreground outline-none focus:border-accent";

// UTC so the server render and the browser agree.
const addedOn = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

function Who({ p }: { p: AccessPerson }) {
  return (
    <>
      <span className="font-medium">{p.name ?? p.email}</span>
      {p.left && <span className="ml-2 rounded bg-pink-500/15 px-1.5 text-[10px] text-pink-300">left</span>}
      <div className="text-xs text-muted">{p.name ? `${p.team ?? "No team"} · ${p.email}` : "Not in Okta"}</div>
    </>
  );
}

/** The access list: pick a person (or type any @intenthq.com address) and a role to add; role changes and Remove take effect on their next page load. */
export function AccessList({ rows, admins, options }: { rows: AccessRowView[]; admins: AccessPerson[]; options: { email: string; label: string }[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [role, setRole] = useState<AccessRole>("viewer");
  const emailByLabel = new Map(options.map((o) => [o.label, o.email]));
  const chosen = emailByLabel.get(input) ?? input.trim();

  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  return (
    <div className="space-y-4">
      {error && <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <datalist id="dashboard-access-people">{options.map((o) => <option key={o.email} value={o.label} />)}</datalist>
        <input
          list="dashboard-access-people" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Add a person or email…"
          aria-label="Give someone dashboard access"
          className="w-80 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
        />
        <select value={role} onChange={(e) => setRole(e.target.value as AccessRole)} aria-label="Role for the person being added" className={selectCls}>
          {(["viewer", "admin"] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <button
          disabled={pending || !chosen}
          onClick={() => run(async () => { await grantDashboardAccess(chosen, role); setInput(""); setRole("viewer"); })}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40"
        >Add</button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody yet: only the admins below can open the dashboard.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Person</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Added</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.email} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2"><Who p={r} /></td>
                  <td className="px-3 py-2">
                    <select
                      value={r.role} disabled={pending} aria-label={`Role for ${r.name ?? r.email}`} className={selectCls}
                      onChange={(e) => run(() => setDashboardAccessRole(r.email, e.target.value))}
                    >
                      {(["viewer", "admin"] as const).map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">{addedOn(r.addedAt)} · {r.addedBy}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-xs">
                    <button disabled={pending} onClick={() => run(() => revokeDashboardAccess(r.email))} className="text-muted hover:text-pink-300">Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Admins set in Vercel (ADMIN_EMAILS) · always admin, changed only there</h3>
        <ul className="space-y-2 text-sm">
          {admins.map((a) => <li key={a.email}><Who p={a} /></li>)}
        </ul>
      </div>
    </div>
  );
}
