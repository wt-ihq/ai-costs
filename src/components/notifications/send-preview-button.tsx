"use client";

import { useState, useTransition } from "react";
import { sendPreviewToMe } from "@/app/(dashboard)/data/notifications-actions";

export function SendPreviewButton({ employeeId, cadence, periodKey }: { employeeId: string; cadence: string; periodKey: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="mt-3 flex items-center gap-3">
      <button
        onClick={() => start(async () => {
          setMsg(null);
          const r = await sendPreviewToMe(employeeId, cadence, periodKey);
          setMsg(r.ok ? "Sent to you in Slack." : `Failed: ${r.error}`);
        })}
        disabled={pending}
        className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-xs text-accent disabled:opacity-40"
      >
        {pending ? "Sending…" : "Send this to me in Slack"}
      </button>
      <span className="text-xs text-muted">{msg ?? "Doesn't count as a send and never goes to the recipient"}</span>
    </div>
  );
}
