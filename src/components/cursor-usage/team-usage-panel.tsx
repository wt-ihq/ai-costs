import Link from "next/link";
import { Panel } from "@/components/ui";
import type { TeamMonthUsage } from "@/lib/cursor-usage/types";
import { formatCount, formatUsd } from "@/lib/utils";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function TeamUsagePanel({ usage, month }: { usage: TeamMonthUsage | null; month: string }) {
  const t = usage?.tiles;
  const peak = usage ? Math.max(1, ...usage.mostActive.map((p) => p.agentRequests)) : 1;

  return (
    <section>
      <h2 className="mb-3 text-sm font-medium text-muted">Cursor usage · {monthLabel(month)}</h2>
      {!usage || !t ? (
        <Panel>
          <div className="flex h-24 items-center justify-center text-sm text-muted">No usage data for this month yet</div>
        </Panel>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Panel className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted">People active</span>
              <span className="text-2xl font-semibold tabular-nums">
                {formatCount(t.peopleActive)} <span className="text-xs font-normal text-muted">of {formatCount(t.seats)} seats</span>
              </span>
              <span className="text-xs text-muted">{formatCount(t.unusedSeats)} seats unused all month</span>
            </Panel>
            <Panel className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted">Agent requests</span>
              <span className="text-2xl font-semibold tabular-nums">{formatCount(t.agentRequests)}</span>
              <span className="text-xs text-muted">{formatCount(t.includedReqs)} included · {formatCount(t.onDemandReqs)} on-demand</span>
            </Panel>
            <Panel className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted">Lines of code kept</span>
              <span className="text-2xl font-semibold tabular-nums">{formatCount(t.linesKept)}</span>
              <span className="text-xs text-muted">{t.keptShare !== null ? `${Math.round(t.keptShare * 100)}% of suggested` : "no suggestions yet"}</span>
            </Panel>
            <Panel className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted">Active days per person</span>
              <span className="text-2xl font-semibold tabular-nums">
                {t.medianActiveDays} <span className="text-xs font-normal text-muted">median</span>
              </span>
              <span className="text-xs text-muted">of {t.workingDays} working days</span>
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <div className="mb-2 text-xs uppercase tracking-wide text-muted">Most active people · agent requests</div>
              {usage.mostActive.length === 0 ? (
                <div className="text-sm text-muted">No one active this month.</div>
              ) : (
                <ul className="space-y-1.5">
                  {usage.mostActive.map((p) => (
                    <li key={p.employeeId} className="flex items-center gap-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <Link href={p.href} className="block truncate hover:underline">{p.name}</Link>
                        <div className="mt-0.5 h-1.5 rounded-full bg-accent" style={{ width: `${(p.agentRequests / peak) * 100}%` }} />
                      </div>
                      <span className="shrink-0 text-right tabular-nums">
                        {formatCount(p.agentRequests)} <span className="text-muted">· {formatUsd(p.onDemandUsd)} on-demand</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel>
              <div className="mb-2 text-xs uppercase tracking-wide text-muted">Seats with little or no use</div>
              {usage.littleUse.length === 0 ? (
                <div className="text-sm text-muted">Every seat was used.</div>
              ) : (
                <ul className="space-y-1.5">
                  {usage.littleUse.map((p) => (
                    <li key={p.employeeId} className="flex items-center justify-between gap-3 text-sm">
                      <Link href={p.href} className="min-w-0 truncate hover:underline">{p.name}</Link>
                      <span className="shrink-0 text-muted">{plural(p.activeDays, "active day")} · {formatUsd(p.seatUsd)} seat</span>
                    </li>
                  ))}
                </ul>
              )}
              {usage.littleUseMore > 0 || usage.unusedSeatsUsd > 0 ? (
                <p className="mt-2 text-xs text-muted">
                  {usage.littleUseMore > 0 ? `… ${usage.littleUseMore} more · ` : ""}
                  {formatUsd(usage.unusedSeatsUsd)} a month in unused seats
                </p>
              ) : null}
            </Panel>
          </div>
        </div>
      )}
    </section>
  );
}
