"use client";

import { useState, useTransition } from "react";
import { sendTestDigest } from "@/app/(dashboard)/data/notifications-actions";
import type { PersonOption } from "@/lib/notify/admin-store";
import type { TestSubject, TestTarget } from "@/lib/notify/subject";

type Choice = "me" | "subject" | "other";

/**
 * Sends the previewed digest as a clearly-marked test: to the admin, to the person it is about
 * (people only), or to anyone chosen. Never a scheduled send. The parent keys this by
 * subject + cadence + period so the choice and result reset when the preview changes.
 */
export function SendTestControls({ subject, subjectName, cadence, periodKey, people }: {
  subject: TestSubject;
  subjectName: string; // the person's name, or the department
  cadence: string;
  periodKey: string;
  people: PersonOption[];
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>("me");
  const [other, setOther] = useState("");
  const byLabel = new Map(people.map((p) => [p.label, p]));
  const otherPerson = byLabel.get(other);

  const send = () => {
    let to: TestTarget;
    if (choice === "me") to = { kind: "me" };
    else if (choice === "subject") to = { kind: "subject" };
    else if (otherPerson) to = { kind: "employee", employeeId: otherPerson.id };
    else return;
    // Only a third party (neither the admin nor the person it is about) needs a second look.
    const thirdParty = choice === "other" && !(subject.kind === "person" && otherPerson?.id === subject.employeeId);
    if (thirdParty && !window.confirm(`Send ${subjectName}'s ${cadence} digest to ${otherPerson?.name}?`)) return;
    start(async () => {
      setMsg(null);
      try {
        const r = await sendTestDigest(subject, cadence, periodKey, to);
        setMsg(r.ok ? `Test sent to ${r.sentTo} in Slack.` : `Failed: ${r.error}`);
      } catch (err) {
        // The action itself threw (e.g. requireAdmin, a network drop) rather than returning { ok: false }.
        setMsg(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  };

  const radio = (value: Choice, label: string) => (
    <label className="flex items-center gap-1 text-foreground">
      <input type="radio" name="notify-test-to" checked={choice === value} onChange={() => setChoice(value)} disabled={pending} />
      {label}
    </label>
  );

  return (
    <div className="mt-3 space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-muted">Send to:</span>
        {radio("me", "Me")}
        {subject.kind === "person" && radio("subject", "This person")}
        {radio("other", "Someone else…")}
        {choice === "other" && (
          <>
            <datalist id="notify-test-people">{people.map((p) => <option key={p.id} value={p.label} />)}</datalist>
            <input
              list="notify-test-people" value={other} onChange={(e) => setOther(e.target.value)} placeholder="Pick an employee…"
              aria-label="Send the test to" disabled={pending}
              className="w-56 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
            />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={send}
          disabled={pending || (choice === "other" && !otherPerson)}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40"
        >
          {pending ? "Sending…" : "Send test"}
        </button>
        <span className="text-muted">{msg ?? "Marked as a test in Slack. Works in any mode and never counts as a scheduled send."}</span>
      </div>
    </div>
  );
}
