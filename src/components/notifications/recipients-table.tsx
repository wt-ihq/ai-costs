"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { addRecipients, addTeamRecipients, removeAllRecipients, removeRecipient, setPersonFixedCosts, setRecipientCadence } from "@/app/(dashboard)/data/notifications-actions";
import type { RecipientRow } from "@/lib/notify/admin-store";
import type { SendNowResult } from "@/lib/notify/send-now";
import { CADENCES, type Cadence, type NotifyMode } from "@/lib/notify/types";
import { sendNowSummary } from "./digests-table";

export const CADENCE_LABEL: Record<Cadence, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
export const SLACK_STATUS: Record<RecipientRow["slack"], { text: string; cls: string }> = {
  found: { text: "✓", cls: "text-emerald-400" },
  not_found: { text: "✗ not found", cls: "text-pink-400" },
  unknown: { text: "not looked up", cls: "text-muted" },
};

export function RecipientsTable({ rows, people, departments, previewing, mode }: {
  rows: RecipientRow[];
  people: { id: string; label: string }[];
  departments: string[];
  previewing: string | null;
  mode: NotifyMode;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const [team, setTeam] = useState("");
  const [defaults, setDefaults] = useState<Cadence[]>(["weekly", "monthly"]);
  const [sendLatest, setSendLatest] = useState(false);
  const [catchUp, setCatchUp] = useState<SendNowResult | null>(null);
  const added = (r: { added: number; catchUp?: SendNowResult }) => setCatchUp(r.catchUp ?? null);
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
        <datalist id="notify-people">{people.map((p) => <option key={p.id} value={p.label} />)}</datalist>
        <input
          list="notify-people" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Add a person…"
          className="w-56 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
        />
        <button
          disabled={pending || !idByLabel.has(person)}
          onClick={() => run(async () => { added(await addRecipients([idByLabel.get(person)!], defaults, sendLatest)); setPerson(""); })}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40"
        >Add</button>
        <select value={team} onChange={(e) => setTeam(e.target.value)} className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground">
          <option value="">Add a team…</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button
          disabled={pending || !team}
          onClick={() => run(async () => { added(await addTeamRecipients(team, defaults, sendLatest)); setTeam(""); })}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40"
        >Add team</button>
        <span className="ml-2 text-muted">New people get:</span>
        {CADENCES.map((c) => (
          <label key={c} className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={defaults.includes(c)} onChange={(e) => setDefaults((d) => (e.target.checked ? [...d, c] : d.filter((x) => x !== c)))} />
            {CADENCE_LABEL[c]}
          </label>
        ))}
        <label className="flex items-center gap-1 text-muted" title={mode === "off" ? "choose Preview or Live first" : undefined}>
          <input type="checkbox" checked={sendLatest && mode !== "off"} disabled={mode === "off"} onChange={(e) => setSendLatest(e.target.checked)} />
          Also send them the latest weekly and monthly now
        </label>
        {rows.length > 0 && (
          <button
            type="button" disabled={pending}
            onClick={() => {
              if (!window.confirm(`Remove all ${rows.length} people from the Pilot list? Their fixed-cost choices and send history are kept, so adding them back restores them.`)) return;
              run(() => removeAllRecipients());
            }}
            className="ml-auto text-muted hover:text-pink-300 disabled:opacity-40"
          >Remove everyone</button>
        )}
      </div>

      {catchUp && (
        <p className={`rounded-md border px-3 py-2 text-sm ${catchUp.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-pink-500/30 bg-pink-500/10 text-pink-300"}`}>
          {sendNowSummary(catchUp)}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody is enrolled yet. Only people listed here get a personal digest.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Person</th>
                {CADENCES.map((c) => <th key={c} className="px-2 py-2 text-center font-medium">{CADENCE_LABEL[c]}</th>)}
                <th className="px-3 py-2 font-medium">Fixed costs</th>
                <th className="px-3 py-2 font-medium">Reports</th>
                <th className="px-3 py-2 font-medium">Slack</th>
                <th className="px-3 py-2 font-medium">Last sent</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId} className={`border-b border-border/60 last:border-0 ${previewing === r.employeeId ? "bg-accent/5" : ""}`}>
                  <td className="px-3 py-2">
                    <span className="font-medium">{r.name}</span>
                    {r.left && <span className="ml-2 rounded bg-pink-500/15 px-1.5 text-[10px] text-pink-300">left</span>}
                    <div className="text-xs text-muted">{r.team ?? "No team"}</div>
                  </td>
                  {CADENCES.map((c) => (
                    <td key={c} className="px-2 py-2 text-center">
                      <input
                        type="checkbox" disabled={pending} checked={r.cadences.includes(c)}
                        onChange={(e) => run(() => setRecipientCadence(r.employeeId, c, e.target.checked))}
                        aria-label={`${CADENCE_LABEL[c]} for ${r.name}`}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <select
                      disabled={pending}
                      value={r.fixedCosts.override === null ? "default" : r.fixedCosts.override ? "include" : "exclude"}
                      onChange={(e) => run(() => setPersonFixedCosts(r.employeeId, e.target.value === "default" ? null : e.target.value === "include"))}
                      aria-label={`Fixed costs for ${r.name}`}
                      className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-xs text-foreground"
                    >
                      <option value="default">
                        Default: {r.fixedCosts.inherited.include ? "include" : "exclude"}{r.fixedCosts.inherited.source === "team" ? " (team)" : ""}
                      </option>
                      <option value="include">Include</option>
                      <option value="exclude">Exclude</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">{r.reports || "—"}</td>
                  <td className={`px-3 py-2 text-xs ${SLACK_STATUS[r.slack].cls}`}>{SLACK_STATUS[r.slack].text}</td>
                  <td className="px-3 py-2 text-xs text-muted">{r.lastSent ?? "never"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-xs">
                    <Link href={`/data?tab=notifications&preview=${r.employeeId}&cadence=${r.cadences[0] ?? "weekly"}`} className="mr-3 text-accent">Preview</Link>
                    <button disabled={pending} onClick={() => run(() => removeRecipient(r.employeeId))} className="text-muted hover:text-pink-300">Remove</button>
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
