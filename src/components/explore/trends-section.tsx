"use client";

import Link from "next/link";
import { useState } from "react";
import type { TrendsData, TrendMover, NotableDay } from "@/lib/explore/trends";
import { formatUsd, cn } from "@/lib/utils";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso: string) => `${Number(iso.slice(8, 10))} ${SHORT_MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/** "+$50 (+50%)" — signed, with the percent when there is a prior to compare against. */
function deltaText(m: { delta: number; pct: number | null }): string {
  const sign = m.delta > 0 ? "+" : m.delta < 0 ? "−" : "";
  const abs = formatUsd(Math.abs(m.delta));
  if (m.pct === null) return `${sign}${abs}`;
  const pct = `${m.pct > 0 ? "+" : m.pct < 0 ? "−" : ""}${Math.abs(m.pct).toFixed(0)}%`;
  return `${sign}${abs} (${pct})`;
}

// Spend going up is the thing to look at, so up is the warm colour.
const upClass = "text-rose-400";
const downClass = "text-emerald-400";

function MoverRow({ m, linkQuery }: { m: TrendMover; linkQuery?: string }) {
  const href = m.href && linkQuery ? `${m.href}?${linkQuery}` : m.href;
  const body = (
    <div className={cn("flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-surface px-3 py-2", href && "hover:border-accent/60 hover:bg-surface-2")}>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{m.label}</div>
        <div className="text-xs tabular-nums text-muted">
          {formatUsd(m.prior)} → {formatUsd(m.current)}
        </div>
      </div>
      <div className={cn("shrink-0 text-sm font-semibold tabular-nums", m.delta > 0 ? upClass : downClass)}>{deltaText(m)}</div>
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

function MoverList({ title, rows, empty, linkQuery }: { title: string; rows: TrendMover[]; empty: string; linkQuery?: string }) {
  return (
    <div>
      <h3 className="mb-2 text-xs uppercase tracking-wide text-muted">{title}</h3>
      {rows.length === 0 ? (
        <div className="text-xs text-muted">{empty}</div>
      ) : (
        <div className="space-y-1.5">{rows.map((m) => <MoverRow key={m.id} m={m} linkQuery={linkQuery} />)}</div>
      )}
    </div>
  );
}

const CHIP_LIMIT = 8;

/** Compact chip list for entities present in only one of the two periods. */
function ChipList({ title, rows, amount, linkQuery }: { title: string; rows: TrendMover[]; amount: (m: TrendMover) => number; linkQuery?: string }) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, CHIP_LIMIT);
  const more = rows.length - shown.length;
  return (
    <div>
      <h3 className="mb-2 text-xs uppercase tracking-wide text-muted">{title}</h3>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((m) => {
          const href = m.href && linkQuery ? `${m.href}?${linkQuery}` : m.href;
          const chip = (
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs", href && "hover:border-accent/60")}>
              <span className="max-w-[16rem] truncate">{m.label}</span>
              <span className="tabular-nums text-muted">{formatUsd(amount(m))}</span>
            </span>
          );
          return href ? <Link key={m.id} href={href}>{chip}</Link> : <span key={m.id}>{chip}</span>;
        })}
        {more > 0 && <span className="inline-flex items-center px-1 text-xs text-muted">+{more} more</span>}
      </div>
    </div>
  );
}

function NotableDays({ days }: { days: NotableDay[] }) {
  if (days.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-xs uppercase tracking-wide text-muted">Notable days</h3>
      <div className="space-y-1.5">
        {days.map((d) => (
          <div key={d.day} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-border/60 bg-surface px-3 py-2 text-sm">
            <span className="font-medium">{shortDay(d.day)}</span>
            <span className="tabular-nums">{formatUsd(d.total)}</span>
            <span className="text-xs text-muted">
              {d.median > 0 ? `${(d.total / d.median).toFixed(1)}× a typical day` : "usage spend"}
              {d.driver ? ` · mostly ${d.driver}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * How the selected period moved against the previous one: headline change,
 * biggest movers at the page's grain, first-time and gone-quiet entities, and
 * days that stood out. All derived in-memory from the scope's facts.
 */
export function TrendsSection({ t, periodLabel, linkQuery }: { t: TrendsData; periodLabel: string; linkQuery?: string }) {
  // Collapsed by default: the header still carries the headline change, so
  // the section reads as a one-line summary until someone wants the detail.
  const [open, setOpen] = useState(false);
  const quiet = t.risers.length + t.fallers.length + t.newSpenders.length + t.goneQuiet.length + t.notableDays.length === 0;
  const empty = t.pct === null && t.prior === 0 && t.current === 0;
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left"
      >
        <svg
          viewBox="0 0 16 16"
          className={cn("size-3.5 shrink-0 text-muted transition-transform", open && "rotate-90")}
          fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden
        >
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
        <h2 className="text-sm font-medium">
          Trends · {periodLabel} vs {t.priorLabel}
        </h2>
        <span
          className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
          title="New — the thresholds and layout may still change. Tell us what's useful."
        >
          Beta
        </span>
        <span className="ml-auto flex flex-wrap items-baseline gap-x-2 text-sm tabular-nums">
          {empty ? (
            <span className="text-muted">no spend either period</span>
          ) : (
            <>
              <span className="font-semibold">{formatUsd(t.current)}</span>
              <span className="text-muted">vs {formatUsd(t.prior)}</span>
              <span className={cn("font-semibold", t.delta > 0 ? upClass : t.delta < 0 ? downClass : "text-muted")}>
                {t.delta === 0 ? "no change" : deltaText(t)}
              </span>
            </>
          )}
        </span>
      </button>

      {open && (
        <div className="mt-4">
          {t.truncatedDays !== null && (
            <div className="mb-4 text-xs text-muted">
              Comparing the first {t.truncatedDays} {t.truncatedDays === 1 ? "day" : "days"} of each period · seats and subscriptions left out
            </div>
          )}

          {quiet ? (
            <div className="text-sm text-muted">Nothing moved much against {t.priorLabel}.</div>
          ) : (
            <div className="space-y-5">
              <div className="grid gap-4 lg:grid-cols-2">
                <MoverList title="Biggest increases" rows={t.risers} empty="No increases." linkQuery={linkQuery} />
                <MoverList title="Biggest decreases" rows={t.fallers} empty="No decreases." linkQuery={linkQuery} />
              </div>
              <ChipList title="New this period" rows={t.newSpenders} amount={(m) => m.current} linkQuery={linkQuery} />
              <ChipList title="Gone quiet" rows={t.goneQuiet} amount={(m) => m.prior} linkQuery={linkQuery} />
              <NotableDays days={t.notableDays} />
            </div>
          )}

          {t.hasEstimatedAllocation && (
            <div className="mt-4 text-xs text-muted">
              Per-person Anthropic figures are an estimated split of the exact daily total, so small movements there may be allocation noise.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
