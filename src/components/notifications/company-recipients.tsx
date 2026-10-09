"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { addCompanyRecipients, removeCompanyRecipient, setCompanyRecipientCadence } from "@/app/(dashboard)/data/notifications-actions";
import type { CompanyRecipientRow, PersonOption } from "@/lib/notify/admin-store";
import { previewHref } from "@/lib/notify/subject";
import { CADENCES, type Cadence } from "@/lib/notify/types";
import { CADENCE_LABEL, SLACK_STATUS } from "./recipients-table";

/** Who gets the whole-company report, and on which cadences. Checkboxes save as you click. */
export function CompanyRecipients({ rows, people }: { rows: CompanyRecipientRow[]; people: PersonOption[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const [defaults, setDefaults] = useState<Cadence[]>(["weekly", "monthly"]);
  const idByLabel = new Map(people.map((p) => [p.label, p.id]));

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
    <div className="space-y-3">
      {error && <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <datalist id="notify-company-people">{people.map((p) => <option key={p.id} value={p.label} />)}</datalist>
        <input
          list="notify-company-people" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Add a person…"
          aria-label="Add a company report recipient"
          className="w-56 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
        />
        <button
          disabled={pending || !idByLabel.has(person) || defaults.length === 0}
          onClick={() => run(async () => { await addCompanyRecipients([idByLabel.get(person)!], defaults); setPerson(""); })}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40"
        >Add</button>
        <span className="ml-2 text-muted">They get:</span>
        {CADENCES.map((c) => (
          <label key={c} className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={defaults.includes(c)} onChange={(e) => setDefaults((d) => (e.target.checked ? [...d, c] : d.filter((x) => x !== c)))} />
            {CADENCE_LABEL[c]}
          </label>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody gets the company report yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Person</th>
                {CADENCES.map((c) => <th key={c} className="px-2 py-2 text-center font-medium">{CADENCE_LABEL[c]}</th>)}
                <th className="px-3 py-2 font-medium">Slack</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2">
                    <span className="font-medium">{r.name}</span>
                    {r.left && <span className="ml-2 rounded bg-pink-500/15 px-1.5 text-[10px] text-pink-300">left</span>}
                    <div className="text-xs text-muted">{r.team ?? "No team"}</div>
                  </td>
                  {CADENCES.map((c) => (
                    <td key={c} className="px-2 py-2 text-center">
                      <input
                        type="checkbox" disabled={pending} checked={r.cadences.includes(c)}
                        onChange={(e) => run(() => setCompanyRecipientCadence(r.employeeId, c, e.target.checked))}
                        aria-label={`Company report ${CADENCE_LABEL[c].toLowerCase()} for ${r.name}`}
                      />
                    </td>
                  ))}
                  <td className={`px-3 py-2 text-xs ${SLACK_STATUS[r.slack].cls}`}>{SLACK_STATUS[r.slack].text}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-xs">
                    <Link href={previewHref({ kind: "company" }, r.cadences[0] ?? "weekly")} className="mr-3 text-accent">Preview</Link>
                    <button disabled={pending} onClick={() => run(() => removeCompanyRecipient(r.employeeId))} className="text-muted hover:text-pink-300">Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
