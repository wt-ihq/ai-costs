"use client";

import { useState, useTransition } from "react";
import { setMonthlyFrom, setNotifyMode } from "@/app/(dashboard)/data/notifications-actions";
import type { NotifyMode } from "@/lib/notify/types";

const MODES: { value: NotifyMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "preview", label: "Preview" },
  { value: "live", label: "Live" },
];

/** Off / Preview / Live. Live asks first: from the next hourly run, real people get real messages. */
export function ModePanel({ mode, modeSource, previewEmail, pilotCount, companyCount, monthlyFrom }: {
  mode: NotifyMode;
  modeSource: "page" | "env";
  previewEmail: string | null;
  pilotCount: number;
  companyCount: number;
  /** The first month that gets a monthly recap ("2026-10"), or null for every month. */
  monthlyFrom: string | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const changeMonthlyFrom = (month: string) =>
    start(async () => {
      setError(null);
      try {
        await setMonthlyFrom(month);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  const inbox = previewEmail ?? "the preview inbox (SLACK_PREVIEW_EMAIL is not set)";
  const explain: Record<NotifyMode, string> = {
    off: "Off: nothing is sent.",
    preview: `Preview: every message goes to ${inbox}, nobody else.`,
    live: "Live: messages go to the people on the lists.",
  };
  const choose = (next: NotifyMode) => {
    if (next === mode) return;
    if (
      next === "live" &&
      !window.confirm(
        `From the next hourly run, ${pilotCount} people on the Pilot list and ${companyCount} on the company-report list get real Slack messages. ` +
          "Anyone who has only had previews gets the welcome message first. Switch to Live?",
      )
    ) return;
    start(async () => {
      setError(null);
      try {
        await setNotifyMode(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };
  return (
    <div>
      <p className="text-[10.5px] uppercase tracking-wide text-muted">Mode</p>
      <div className="my-1 flex gap-1" role="group" aria-label="Slack message mode">
        {MODES.map((m) => (
          <button
            key={m.value} type="button" disabled={pending} onClick={() => choose(m.value)} aria-pressed={m.value === mode}
            className={`rounded-md border px-2.5 py-0.5 text-xs ${m.value === mode ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:text-foreground"} disabled:opacity-40`}
          >{m.label}</button>
        ))}
      </div>
      <p className="text-xs text-muted">{explain[mode]}</p>
      {modeSource === "env" && <p className="mt-1 text-xs text-muted">Set by the Vercel variable until you pick one here.</p>}
      <label className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>First monthly recap</span>
        <input
          type="month" value={monthlyFrom ?? ""} disabled={pending} onChange={(e) => changeMonthlyFrom(e.target.value)}
          className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-xs text-foreground"
          title="The first month that gets a monthly recap; earlier months are never sent. Empty = every month."
        />
        <span>{monthlyFrom ? "(sent early the month after)" : "every month"}</span>
      </label>
      {error && <p className="mt-1 text-xs text-pink-300">Failed: {error}</p>}
    </div>
  );
}
