"use client";

import { useState } from "react";
import Link from "next/link";
import { VENDOR_LABEL } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { formatWholeUsd } from "@/lib/utils";
import { personHref } from "@/lib/notify/digest";
import { outstandingShort } from "@/lib/notify/readiness";
import type { RecommendationsData } from "@/lib/recommendations/load";
import type { RecTool, RecToolResult } from "@/lib/recommendations/rule";
import { WeekBars } from "./week-bars";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parts(s: string): Date {
  return new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
}
const dMon = (s: string) => `${parts(s).getUTCDate()} ${MON[parts(s).getUTCMonth()]}`;
const dMonth = (s: string) => `${parts(s).getUTCDate()} ${MONTH[parts(s).getUTCMonth()]}`;
const weekdayDMon = (s: string) => `${WEEKDAY[parts(s).getUTCDay()]} ${dMon(s)}`;

const EXTRA_HEADER: Record<RecTool, string> = {
  cursor: "On-demand, 4 weeks",
  claude_team: "Extra usage, 4 weeks",
  chatgpt_business: "Credits, 4 weeks",
};

function sourceLine(tool: RecTool, data: RecommendationsData): string {
  if (tool === "cursor") {
    const d = data.rosterAsOf.cursor;
    return `${d ? `Seat tiers from the members export of ${dMon(d)}` : "Seat tiers from the members export"} · on-demand spend from the nightly sync`;
  }
  if (tool === "claude_team") return "Seat tiers from the roster · extra usage from the Monday paste";
  return "Seat tiers from the roster · credits from the latest import";
}

function ToolPill({ tool }: { tool: RecTool }) {
  const c = VENDOR_COLORS[tool];
  return (
    <span
      className="inline-block rounded-full border px-2 py-px text-xs"
      style={{ background: `${c}26`, borderColor: `${c}66` }}
    >
      {VENDOR_LABEL[tool]}
    </span>
  );
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

export function RecommendationsView({ data }: { data: RecommendationsData }) {
  const [team, setTeam] = useState("All");
  const results = data.tools.map((t): RecToolResult => ({
    ...t,
    rows: team === "All" ? t.rows : t.rows.filter((r) => (r.department ?? "Unattributed") === team),
  }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="font-medium">Four weeks to Sunday {dMonth(data.sunday)}</span>
        <span className="text-muted">·</span>
        <label className="flex items-center gap-2">
          Team:
          <select
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
          >
            <option value="All">All</option>
            {data.departments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-xs text-muted">
          {data.readiness.ready
            ? `Updated ${weekdayDMon(data.updatedAt)}, after the weekly sync`
            : `Latest week not ready yet: ${data.readiness.outstanding.map(outstandingShort).join(" · ")}`}
        </span>
      </div>

      {data.cursorRosterStale && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
          {data.rosterAsOf.cursor
            ? `Cursor seat tiers from ${dMon(data.rosterAsOf.cursor)} — upload a newer members export`
            : "No Cursor members export uploaded yet"}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        {data.tools.map((t) => (
          <div key={t.tool} className="rounded-xl border border-border bg-surface p-5">
            <div className="text-xs text-muted">
              {VENDOR_LABEL[t.tool]} · Standard → Premium is +{formatWholeUsd(t.stepUpUsd)} a month
            </div>
            <div className="mt-1 text-2xl font-semibold">{people(t.rows.length)}</div>
            <div className="mt-1 text-xs text-muted">
              {formatWholeUsd(t.totalSavingUsd)} potential saving · {t.premiumCount} already on Premium
            </div>
          </div>
        ))}
      </div>

      {results.map((t) => (
        <section key={t.tool}>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ToolPill tool={t.tool} /> {people(t.rows.length)}
            </h2>
            <span className="text-xs text-muted">{sourceLine(t.tool, data)}</span>
          </div>
          {!data.rosterAsOf[t.tool] && (
            <p className="mb-2 text-sm text-muted">No {VENDOR_LABEL[t.tool]} roster uploaded yet — tiers unknown.</p>
          )}
          {t.rows.length === 0 ? (
            <p className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
              Nobody on a Standard seat is over the line.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl md:overflow-visible border border-border bg-surface">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="px-3 py-2 font-semibold">Person</th>
                    <th className="px-3 py-2 font-semibold">Team</th>
                    <th className="px-3 py-2 text-right font-semibold">{EXTRA_HEADER[t.tool]}</th>
                    <th className="px-3 py-2 text-right font-semibold">Potential saving</th>
                    <th className="px-3 py-2 font-semibold">Last 4 weeks</th>
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r) => (
                    <tr key={r.employeeId} className="border-b border-border/50 last:border-0">
                      <td className="px-3 py-2">
                        <Link
                          href={personHref("", { id: r.employeeId, department: r.department })}
                          className="hover:text-accent"
                        >
                          {r.name}
                        </Link>
                        {r.tierUnknown && <span className="ml-2 text-xs text-muted">tier unknown</span>}
                      </td>
                      <td className="px-3 py-2 text-muted">{r.department ?? "Unattributed"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatWholeUsd(r.extraUsd)}</td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums">{formatWholeUsd(r.savingUsd)}</td>
                      <td className="px-3 py-2">
                        <WeekBars cells={r.weeks} tool={t.tool} />{" "}
                        <span className="text-muted">{r.pattern}</span>
                        {r.newThisWeek && (
                          <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                            new this week
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      <p className="text-xs text-muted">
        Flagged when four weeks of extra spend exceed the monthly step up to Premium. &quot;Potential saving&quot; is extra spend minus the step up; Premium would have cost less, it would not have covered all of it. The bars are each week&apos;s extra spend; the word next to them says whether it is steady, recent, one-off or on and off.
      </p>
    </div>
  );
}
