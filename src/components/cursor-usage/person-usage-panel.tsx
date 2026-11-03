"use client";

import { useState } from "react";
import { Panel } from "@/components/ui";
import { personMonthUsage } from "@/lib/cursor-usage/shape";
import type { PersonCursorUsageScope, UsageWeekDay } from "@/lib/cursor-usage/types";
import { modelLabel } from "@/lib/model-labels";
import { formatCount, formatUsd } from "@/lib/utils";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${SHORT[Number(d.slice(5, 7)) - 1]}`;

const INCLUDED = "rgba(80,140,255,.55)";
const ON_DEMAND = "rgba(230,120,80,.7)";
const INACTIVE = "rgba(128,128,128,.25)";

function dayTitle(d: UsageWeekDay): string {
  if (!d.active) return `${dayLabel(d.day)} · not active`;
  const od = d.onDemandUsd > 0 ? ` · ${formatUsd(d.onDemandUsd)} on-demand` : "";
  return `${dayLabel(d.day)} · ${formatCount(d.agentRequests)} requests${od}`;
}

export function PersonUsagePanel({ scope }: { scope: PersonCursorUsageScope }) {
  const [month, setMonth] = useState(scope.months[scope.months.length - 1]);
  const usage = personMonthUsage(scope, month);
  const t = usage?.tiles;
  const peak = usage ? Math.max(1, ...usage.weeks.flatMap((w) => w.days.map((d) => d.agentRequests))) : 1;

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-medium text-muted">Cursor usage · {monthLabel(month)}</h2>
        <select
          aria-label="Month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
        >
          {scope.months.map((m) => (
            <option key={m} value={m}>{monthLabel(m)}</option>
          ))}
        </select>
      </div>

      {!usage || !t ? (
        <Panel>
          <div className="flex h-24 items-center justify-center text-sm text-muted">No usage data for this month yet</div>
        </Panel>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Panel className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted">Active days</span>
              <span className="text-2xl font-semibold tabular-nums">
                {t.activeDays} <span className="text-xs font-normal text-muted">of {t.workingDays} working days</span>
              </span>
              <span className="text-xs text-muted">most-used model: {t.mostUsedModel ? modelLabel(t.mostUsedModel) : "none"}</span>
            </Panel>
            <Panel className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted">Agent requests</span>
              <span className="text-2xl font-semibold tabular-nums">{formatCount(t.agentRequests)}</span>
              <span className="text-xs text-muted">{formatCount(t.includedReqs)} included · {formatCount(t.onDemandReqs)} on-demand</span>
            </Panel>
            <Panel className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted">Lines of code kept</span>
              <span className="text-2xl font-semibold tabular-nums">{formatCount(t.linesKept)}</span>
              <span className="text-xs text-muted">
                of {formatCount(t.linesSuggested)} suggested{t.keptShare !== null ? ` · ${Math.round(t.keptShare * 100)}% kept` : ""}
              </span>
            </Panel>
            <Panel className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted">Spend</span>
              <span className="text-2xl font-semibold tabular-nums">{formatUsd(t.seatUsd + t.onDemandUsd)}</span>
              <span className="text-xs text-muted">
                {formatUsd(t.seatUsd)} seat · {formatUsd(t.onDemandUsd)} on-demand{t.onDemandFrom ? ` from ${dayLabel(t.onDemandFrom)}` : ""}
              </span>
            </Panel>
          </div>

          <Panel>
            <div className="mb-2 text-xs uppercase tracking-wide text-muted">Agent requests per day</div>
            <div className="flex gap-2.5">
              {usage.weeks.map((w) => (
                <div key={w.monday} className="min-w-0 flex-1">
                  <div className="flex h-14 items-end gap-[3px] border-b border-border">
                    {w.days.map((d) =>
                      !d.inMonth ? (
                        <div key={d.day} className="flex-1" />
                      ) : (
                        <div
                          key={d.day}
                          title={dayTitle(d)}
                          className="flex-1 rounded-t-sm"
                          style={{
                            height: d.active ? `${Math.max(4, (d.agentRequests / peak) * 100)}%` : 3,
                            background: !d.active ? INACTIVE : d.onDemandUsd > 0 ? ON_DEMAND : INCLUDED,
                          }}
                        />
                      ),
                    )}
                  </div>
                  <div className="mt-1 flex flex-col items-start gap-px text-[11px]">
                    <b className="font-semibold">{dayLabel(w.monday)}</b>
                    <span className="text-muted">
                      {formatCount(w.requests)} requests{w.onDemandUsd > 0 ? ` · ${formatUsd(w.onDemandUsd)} on-demand` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Each group is a week starting on the Monday shown, Mon to Sun.
              <i className="mx-1 ml-2 inline-block size-[9px] rounded-sm align-middle" style={{ background: INCLUDED }} />included
              <i className="mx-1 ml-2 inline-block size-[9px] rounded-sm align-middle" style={{ background: ON_DEMAND }} />day with on-demand charges
              <i className="mx-1 ml-2 inline-block size-[9px] rounded-sm align-middle" style={{ background: INACTIVE }} />not active · blank = outside {MONTH_NAMES[Number(month.slice(5, 7)) - 1]}. Hover a day for its date and figures.
            </p>
          </Panel>
        </div>
      )}
    </section>
  );
}
