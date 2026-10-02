"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { PersonOption } from "@/lib/notify/admin-store";
import { previewHref, type TestSubject } from "@/lib/notify/subject";
import type { Cadence } from "@/lib/notify/types";

/**
 * Preview any active person or any Okta team. Choosing one navigates (the tab is link-driven: the
 * subject lives in the URL), keeping the current cadence and dropping the period so it opens on the
 * latest complete one. The parent remounts this (key) per subject, so the select can be uncontrolled
 * (defaultValue): it keeps showing the choice while the new preview loads, then remounts with it.
 */
export function PreviewPicker({ people, departments, cadence, current, currentPersonLabel }: {
  people: PersonOption[];
  departments: string[];
  cadence: Cadence;
  current: TestSubject | null;
  currentPersonLabel: string | null;
}) {
  const router = useRouter();
  const [loading, startNav] = useTransition();
  const [person, setPerson] = useState(current?.kind === "person" ? (currentPersonLabel ?? "") : "");
  const idByLabel = new Map(people.map((p) => [p.label, p.id]));

  const go = (subject: TestSubject) => startNav(() => router.push(previewHref(subject, cadence)));

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted">Preview:</span>
      <datalist id="notify-preview-people">{people.map((p) => <option key={p.id} value={p.label} />)}</datalist>
      <input
        list="notify-preview-people" value={person} placeholder="Any person…" aria-label="Preview a person"
        onChange={(e) => {
          setPerson(e.target.value);
          const id = idByLabel.get(e.target.value);
          if (id) go({ kind: "person", employeeId: id });
        }}
        className="w-56 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
      />
      <span className="text-muted">or</span>
      <select
        defaultValue={current?.kind === "team" ? current.department : ""} aria-label="Preview a team"
        onChange={(e) => { if (e.target.value) go({ kind: "team", department: e.target.value }); }}
        className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground"
      >
        <option value="">Any team…</option>
        {departments.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      {loading && <span className="text-muted" role="status">Loading…</span>}
    </div>
  );
}
