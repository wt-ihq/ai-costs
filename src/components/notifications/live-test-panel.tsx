"use client";

import { useState, useTransition } from "react";
import { sendLiveTestDigests } from "@/app/(dashboard)/data/notifications-actions";
import type { RecipientRow } from "@/lib/notify/admin-store";
import type { SendNowResult } from "@/lib/notify/send-now";
import { sendNowSummary } from "./digests-table";

/**
 * Real messages to a few named people before the mode goes Live: tick them, press, confirm. Each gets
 * exactly their first live message (welcome, latest week, last month if ready), claimed as live so
 * Live mode later neither repeats it nor welcomes them again. The weekly can be sent past readiness.
 */
export function LiveTestPanel({ people }: { people: Pick<RecipientRow, "employeeId" | "name" | "cadences">[] }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [forceWeekly, setForceWeekly] = useState(false);
  const [result, setResult] = useState<SendNowResult | null>(null);
  const [pending, start] = useTransition();
  const toggle = (id: string, on: boolean) =>
    setChosen((c) => { const n = new Set(c); if (on) n.add(id); else n.delete(id); return n; });
  const send = () => {
    const names = people.filter((p) => chosen.has(p.employeeId)).map((p) => p.name);
    if (
      !window.confirm(
        `Send real Slack messages now to ${names.join(", ")}? ` +
          "Each gets the welcome message and their latest weekly and monthly. This counts as their first live message.",
      )
    ) return;
    start(async () => {
      setResult(null);
      try {
        setResult(await sendLiveTestDigests([...chosen], forceWeekly));
      } catch (err) {
        setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  };
  return (
    <div>
      <p className="text-[10.5px] uppercase tracking-wide text-muted">Live test</p>
      <p className="my-1 text-xs text-muted">Real messages to a few people now, whatever the mode. Counts as their first live message.</p>
      {people.length === 0 ? (
        <p className="text-xs text-muted">Nobody is on the Pilot list yet.</p>
      ) : (
        <div className="mt-2 max-h-36 space-y-1 overflow-y-auto pr-1 text-xs">
          {people.map((p) => (
            <label key={p.employeeId} className="flex items-center gap-2">
              <input type="checkbox" disabled={pending} checked={chosen.has(p.employeeId)} onChange={(e) => toggle(p.employeeId, e.target.checked)} />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto shrink-0 text-muted">{p.cadences.join(", ")}</span>
            </label>
          ))}
        </div>
      )}
      <label className="mt-2 flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" disabled={pending} checked={forceWeekly} onChange={(e) => setForceWeekly(e.target.checked)} />
        Send the weekly even if its data isn&apos;t complete
      </label>
      <button
        type="button"
        disabled={pending || chosen.size === 0}
        onClick={send}
        className="mt-2 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:bg-surface-2/60 disabled:opacity-50"
      >
        {pending ? "Sending…" : chosen.size ? `Send for real to ${chosen.size}` : "Send for real"}
      </button>
      {result && (
        <p className={`mt-2 rounded-md border px-2 py-1 text-xs ${result.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-pink-500/30 bg-pink-500/10 text-pink-300"}`}>
          {sendNowSummary(result)}
        </p>
      )}
    </div>
  );
}
