"use client";

import { useState, useTransition } from "react";
import { addReminderRecipient, removeReminderRecipientAction } from "@/app/(dashboard)/data/notifications-actions";
import type { PersonOption, ReminderRecipientRow } from "@/lib/notify/admin-store";
import { SLACK_STATUS } from "./recipients-table";

/** Who gets the update reminders. */
export function ReminderRecipients({ rows, people }: { rows: ReminderRecipientRow[]; people: PersonOption[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState("");
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
        <datalist id="notify-reminder-people">{people.map((p) => <option key={p.id} value={p.label} />)}</datalist>
        <input list="notify-reminder-people" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Add a person…" aria-label="Add an update-reminder recipient"
          className="w-56 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        <button disabled={pending || !idByLabel.has(person)} onClick={() => run(async () => { await addReminderRecipient(idByLabel.get(person)!); setPerson(""); })}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40">Add</button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody gets the reminders yet.</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border text-sm">
          {rows.map((r) => (
            <li key={r.employeeId} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>
                <span className="font-medium">{r.name}</span>
                {r.left && <span className="ml-2 rounded bg-pink-500/15 px-1.5 text-[10px] text-pink-300">left</span>}
                <span className={`ml-2 text-xs ${SLACK_STATUS[r.slack].cls}`}>{SLACK_STATUS[r.slack].text}</span>
              </span>
              <button disabled={pending} onClick={() => run(() => removeReminderRecipientAction(r.employeeId))} className="text-xs text-muted hover:text-pink-300">Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
