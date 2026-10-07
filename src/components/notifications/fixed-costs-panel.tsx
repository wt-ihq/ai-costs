"use client";

import { useState, useTransition } from "react";
import { setOrgFixedCosts, setTeamFixedCosts } from "@/app/(dashboard)/data/notifications-actions";
import type { FixedCostSettings } from "@/lib/notify/fixed-costs";

type Choice = "include" | "exclude";
const toChoice = (include: boolean): Choice => (include ? "include" : "exclude");

/** The organisation default for seats & subscriptions in digests, plus per-team overrides. People are set in the recipients table. */
export function FixedCostsPanel({ settings, departments }: { settings: FixedCostSettings; departments: string[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState("");
  const [choice, setChoice] = useState<Choice>("include");
  const overrides = Object.entries(settings.departments).sort(([a], [b]) => a.localeCompare(b));
  const free = departments.filter((d) => !(d in settings.departments));

  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  const select = "rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground";
  return (
    <div className="space-y-3 text-sm">
      {error && <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-pink-300">Failed: {error}</p>}
      <label className="flex items-center gap-2">
        <input type="checkbox" disabled={pending} checked={settings.orgInclude} onChange={(e) => run(() => setOrgFixedCosts(e.target.checked))} />
        Include seats &amp; subscriptions by default
      </label>

      <div>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-muted">Team overrides</h3>
        {overrides.length === 0 ? (
          <p className="text-xs text-muted">None — every team follows the default.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border">
            {overrides.map(([dept, include]) => (
              <li key={dept} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <span>{dept}</span>
                <span className="flex items-center gap-3 text-xs">
                  <select
                    disabled={pending} value={toChoice(include)} aria-label={`Fixed costs for ${dept}`}
                    onChange={(e) => run(() => setTeamFixedCosts(dept, e.target.value === "include"))} className={select}
                  >
                    <option value="include">Include</option>
                    <option value="exclude">Exclude</option>
                  </select>
                  <button disabled={pending} onClick={() => run(() => setTeamFixedCosts(dept, null))} className="text-muted hover:text-pink-300">Remove</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <select value={team} onChange={(e) => setTeam(e.target.value)} className={select}>
            <option value="">Override a team…</option>
            {free.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={choice} onChange={(e) => setChoice(e.target.value as Choice)} className={select} aria-label="Override value">
            <option value="include">Include</option>
            <option value="exclude">Exclude</option>
          </select>
          <button
            disabled={pending || !team}
            onClick={() => run(async () => { await setTeamFixedCosts(team, choice === "include"); setTeam(""); })}
            className="rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40"
          >Add</button>
        </div>
      </div>
    </div>
  );
}
