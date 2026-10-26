"use client";

import { useState, useTransition } from "react";
import { sendDigestNow } from "@/app/(dashboard)/data/notifications-actions";
import type { DigestStatusRow } from "@/lib/notify/digest-status";
import type { SendNowResult } from "@/lib/notify/send-now";
import type { NotifyMode } from "@/lib/notify/types";

const STATE_CLS: Record<DigestStatusRow["state"], string> = {
  waiting: "text-amber-300",
  skipped: "text-amber-300",
  before_start: "text-muted",
  ready: "text-emerald-300",
  sent: "text-foreground",
};

/** One line of plain words for what a send did. */
export function sendNowSummary(r: SendNowResult): string {
  if (!r.ok) return `Failed: ${r.error}`;
  const parts = [`Sent to ${r.sent}.`];
  if (r.alreadyHandled) parts.push(`${r.alreadyHandled} already had it.`);
  if (r.failed.length) parts.push(`${r.failed.length} failed: ${r.failed.map((f) => `${f.name} (${f.detail})`).join(", ")}.`);
  if (r.notReached.length) parts.push(`Not reached in time: ${r.notReached.join(", ")}. Click Send now again to send to them.`);
  if (r.held) parts.push(`${r.held}.`);
  return parts.join(" ");
}

/** The weekly and monthly digests in play, each with its status, next automatic send, and a Send now button. */
export function DigestsTable({ rows, mode }: { rows: DigestStatusRow[]; mode: NotifyMode }) {
  const [pending, start] = useTransition();
  const [sending, setSending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ key: string; text: string; failed: boolean } | null>(null);

  const send = (row: DigestStatusRow) => {
    if (!row.sendNow || !window.confirm(row.sendNow.confirm)) return;
    setSending(row.periodKey);
    setOutcome(null);
    start(async () => {
      try {
        const r = await sendDigestNow(row.cadence, row.periodKey, row.sendNow!.label === "Send anyway", mode);
        setOutcome({ key: row.periodKey, text: sendNowSummary(r), failed: !r.ok });
      } catch (err) {
        setOutcome({ key: row.periodKey, text: `Failed: ${err instanceof Error ? err.message : String(err)}`, failed: true });
      } finally {
        setSending(null);
      }
    });
  };

  return (
    <div className="space-y-2">
      <p className="text-[10.5px] uppercase tracking-wide text-muted">Digests</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th className="py-2 pr-3 font-medium">Digest</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 font-medium">Next automatic send</th>
              <th className="py-2 pr-3 font-medium">Sent</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const disabled = pending || mode === "off" || r.recipients === 0 || !r.sendNow;
              const title = mode === "off" ? "Choose Preview or Live first" : r.recipients === 0 ? "Nobody has this cadence ticked" : undefined;
              return (
                <tr key={r.periodKey} className="border-b border-border/60 align-top last:border-0">
                  <td className="whitespace-nowrap py-2 pr-3 font-medium">{r.label}</td>
                  <td className={`py-2 pr-3 ${STATE_CLS[r.state]}`}>{r.statusText}</td>
                  <td className="py-2 pr-3 text-xs text-muted">{r.nextSend ?? "—"}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-xs text-muted">{r.sentText ?? "—"}</td>
                  <td className="whitespace-nowrap py-2 text-right">
                    {r.sendNow && (
                      <button
                        type="button" disabled={disabled} title={title} onClick={() => send(r)}
                        className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-xs text-accent disabled:opacity-40"
                      >{sending === r.periodKey ? "Sending…" : r.sendNow.label}</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {outcome && (
        <p className={`rounded-md border px-3 py-2 text-sm ${outcome.failed ? "border-pink-500/30 bg-pink-500/10 text-pink-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"}`}>
          {rows.find((r) => r.periodKey === outcome.key)?.label}: {outcome.text}
        </p>
      )}
    </div>
  );
}
