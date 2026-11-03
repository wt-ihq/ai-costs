"use client";

import { useState, useTransition } from "react";
import { addRecommendationRecipient, removeRecommendationRecipientAction, sendRecommendationsNow } from "@/app/(dashboard)/data/notifications-actions";
import type { PersonOption, ReminderRecipientRow } from "@/lib/notify/admin-store";
import type { RunRecommendationsResult } from "@/lib/notify/run-recommendations";
import type { NotifyMode } from "@/lib/notify/types";
import { SLACK_STATUS } from "./recipients-table";

export interface RecommendationsStatus {
  weekLabel: string;
  periodKey: string;
  ready: boolean;
  outstanding: string[];
  recipients: number;
  sent: number;
}

/** What a run did, in a line. */
function describe(r: RunRecommendationsResult): string {
  if (r.error) return `Stopped: ${r.error}`;
  if (r.held) return `Held: ${r.held}`;
  const parts = [`${r.sent} sent`];
  if (r.alreadyHandled) parts.push(`${r.alreadyHandled} already had it`);
  if (r.failed) parts.push(`${r.failed} failed`);
  return parts.join(" · ");
}

/** Who gets the Monday Premium recommendations message, this week's status, and Send now. */
export function RecommendationsPanel({ rows, people, status, mode, previewHref }: {
  rows: ReminderRecipientRow[]; people: PersonOption[]; status: RecommendationsStatus | { error: string }; mode: NotifyMode; previewHref: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const [sendLatest, setSendLatest] = useState(false);
  const idByLabel = new Map(people.map((p) => [p.label, p.id]));
  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError(null);
      setNote(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  const send = (force: boolean) =>
    run(async () => {
      const r = await sendRecommendationsNow(force, mode);
      if (r.ok) setNote(describe(r.result));
      else setError(r.error);
    });
  return (
    <div className="space-y-3">
      {error && <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>}
      {note && <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">{note}</p>}
      {"error" in status ? (
        <p className="text-sm text-pink-300">Status unavailable: {status.error}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <span>
            Week {status.weekLabel} · {status.ready ? <span className="text-emerald-400">ready</span> : <span className="text-muted">waiting for {status.outstanding.join(" · ")}</span>}
          </span>
          <span className="text-muted">{status.recipients} recipients · {status.sent} sent</span>
          <button disabled={pending || !status.ready || mode === "off" || status.recipients === 0} onClick={() => send(false)}
            className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40">Send now</button>
          {!status.ready && (
            <button disabled={pending || mode === "off" || status.recipients === 0} onClick={() => send(true)}
              className="rounded-md border border-border px-3 py-1 text-muted hover:text-foreground disabled:opacity-40">Send anyway</button>
          )}
          <a href={previewHref} className="text-accent">Preview</a>
          {mode === "off" && <span className="text-muted">Choose Preview or Live first</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <datalist id="notify-recommendation-people">{people.map((p) => <option key={p.id} value={p.label} />)}</datalist>
        <input list="notify-recommendation-people" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Add a person…" aria-label="Add a recommendations recipient"
          className="w-56 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        <label className="flex items-center gap-1 text-muted">
          <input type="checkbox" checked={sendLatest} onChange={(e) => setSendLatest(e.target.checked)} />
          Also send them this week&apos;s message now
        </label>
        <button disabled={pending || !idByLabel.has(person)}
          onClick={() => run(async () => {
            const r = await addRecommendationRecipient(idByLabel.get(person)!, sendLatest);
            setPerson("");
            if (r.sent) setNote(describe(r.sent));
          })}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40">Add</button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody gets the recommendations yet.</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border text-sm">
          {rows.map((r) => (
            <li key={r.employeeId} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>
                <span className="font-medium">{r.name}</span>
                {r.left && <span className="ml-2 rounded bg-pink-500/15 px-1.5 text-[10px] text-pink-300">left</span>}
                <span className={`ml-2 text-xs ${SLACK_STATUS[r.slack].cls}`}>{SLACK_STATUS[r.slack].text}</span>
              </span>
              <button disabled={pending} onClick={() => run(() => removeRecommendationRecipientAction(r.employeeId))} className="text-xs text-muted hover:text-pink-300">Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
