"use client";

import { useState, useTransition } from "react";
import { saveSeatMonthEntries, deleteSeatMonthEntry, type SeatEntryInput } from "@/app/(dashboard)/imports/actions";
import { formatUsd } from "@/lib/utils";
import { VENDOR_LABEL } from "@/lib/types";
import type { TieredVendor } from "@/lib/ingest/seat-months";
import { monthName } from "@/lib/imports/checklist";
import { useFxRate } from "@/components/imports/fx-rate";

export interface SeatMonthEntryRow {
  vendor: string; // 'chatgpt_business' | 'claude_team'
  seatType: string; // 'standard' | 'premium'
  month: string; // YYYY-MM
  seats: number;
  priceUsd: number;
  priceGbp: number | null;
  fxRate: number | null;
}

const TIER_LABEL: Record<string, string> = { standard: "Standard", premium: "Premium" };
/** Entries shown before "Show all". */
const RECENT = 6;

const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthLabel = (m: string) => (/^\d{4}-\d{2}$/.test(m) ? `${monthName(m).slice(0, 3)} ${m.slice(0, 4)}` : m);

/** Price prefill when a tier has no entry yet — ChatGPT in $, Claude in £. */
const FALLBACK_PRICE: Record<string, string> = {
  "chatgpt_business:standard": "25",
  "chatgpt_business:premium": "125",
  "claude_team:standard": "15",
  "claude_team:premium": "75",
};

interface TierFields {
  stdSeats: string;
  stdPrice: string;
  premSeats: string;
  premPrice: string;
  /** The £→$ rate saved with this Claude month; null = a new month, priced at the column's shared rate. */
  savedRate: number | null;
}

const inputCls = "rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent";

/** One vendor's invoice seat counts: the month form, then its entries (newest first, the latest few unless expanded). */
export function SeatMonthEntries({ vendor, entries }: { vendor: TieredVendor; entries: SeatMonthEntryRow[] }) {
  const fx = useFxRate();
  const isClaude = vendor === "claude_team";
  const cur = isClaude ? "£" : "$";
  const initialMonth = new Date().toISOString().slice(0, 7);

  // Entries are newest-first (imports-tab.tsx orders them), so `find` returns the latest.
  const mine = entries.filter((e) => e.vendor === vendor);
  const latest = (t: string) => mine.find((e) => e.seatType === t);
  const savedFor = (t: string, m: string) => mine.find((e) => e.seatType === t && e.month === m);
  // Claude entries are edited in the £ they were entered in.
  const shownPrice = (e: SeatMonthEntryRow) => String(isClaude ? e.priceGbp ?? e.priceUsd : e.priceUsd);
  const prefillPrice = (t: string) => {
    const e = latest(t);
    return e ? shownPrice(e) : FALLBACK_PRICE[`${vendor}:${t}`];
  };

  // A month's saved values, or the prefill chain with seats left blank.
  const fieldsFor = (m: string): TierFields => {
    const std = savedFor("standard", m);
    const prem = savedFor("premium", m);
    return {
      stdSeats: std ? String(std.seats) : "",
      stdPrice: std ? shownPrice(std) : prefillPrice("standard"),
      premSeats: prem ? String(prem.seats) : "",
      premPrice: prem ? shownPrice(prem) : prefillPrice("premium"),
      savedRate: std?.fxRate ?? prem?.fxRate ?? null,
    };
  };

  const [month, setMonth] = useState(initialMonth);
  const [fields, setFields] = useState(() => fieldsFor(initialMonth));
  const [showAll, setShowAll] = useState(false);
  const setField = (k: Exclude<keyof TierFields, "savedRate">) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [k]: e.target.value }));

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onMonth = (m: string) => {
    setMonth(m);
    setFields(fieldsFor(m));
  };

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      setSaved(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  const rate = isClaude ? (fields.savedRate ?? Number(fx?.rate)) : null;
  const hasInput = fields.stdSeats.trim() !== "" || fields.premSeats.trim() !== "";
  const rateOk = !isClaude || (rate !== null && rate > 0);

  const onSave = () =>
    run(async () => {
      const inputs: SeatEntryInput[] = [];
      // A blank tier is left untouched; "0" pins that tier to zero seats.
      if (fields.stdSeats.trim() !== "") inputs.push({ seatType: "standard", seats: Number(fields.stdSeats), price: Number(fields.stdPrice) || 0 });
      if (fields.premSeats.trim() !== "") inputs.push({ seatType: "premium", seats: Number(fields.premSeats), price: Number(fields.premPrice) || 0 });
      const { written } = await saveSeatMonthEntries(month, vendor, inputs, rate);
      setSaved(`Saved ${monthLabel(month)}: ${written} facts written.`);
    });

  const onDelete = (m: string, t: string) => {
    if (!window.confirm(`Remove ${monthLabel(m)} ${TIER_LABEL[t] ?? t} seats? That tier goes back to synced members × the default price.`)) return;
    run(async () => {
      const { written } = await deleteSeatMonthEntry(m, vendor, t);
      setSaved(`Removed ${monthLabel(m)} ${TIER_LABEL[t] ?? t}: back to synced members × default price (${written} facts).`);
    });
  };

  const shown = showAll ? mine : mine.slice(0, RECENT);

  return (
    <div className="space-y-3">
      <div className="grid gap-x-4 gap-y-2.5 text-sm text-muted sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          Month
          {/* Default is the client's local date; the server-rendered value can differ by a day. */}
          <input type="month" value={month} onChange={(e) => onMonth(e.target.value)} suppressHydrationWarning className={inputCls} />
        </label>
        <div className="hidden sm:block" />
        <label className="flex flex-col gap-1">
          Standard seats
          <input type="number" min="0" step="1" value={fields.stdSeats} onChange={setField("stdSeats")} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">
          {cur} per standard seat
          <input type="number" min="0" step="0.01" value={fields.stdPrice} onChange={setField("stdPrice")} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">
          Premium seats
          <input type="number" min="0" step="1" value={fields.premSeats} onChange={setField("premSeats")} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">
          {cur} per premium seat
          <input type="number" min="0" step="0.01" value={fields.premPrice} onChange={setField("premPrice")} className={inputCls} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onSave}
          disabled={pending || !month || !hasInput || !rateOk}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-sm text-accent disabled:opacity-40"
        >
          {pending ? "Saving…" : `Save ${/^\d{4}-\d{2}$/.test(month) ? monthName(month) : "month"}`}
        </button>
        <span className="text-xs text-muted">
          {isClaude
            ? fields.savedRate !== null
              ? `Converted at ${fields.savedRate}, the rate saved with ${monthLabel(month)}.`
              : "Converted at the £ → $ rate above."
            : "Synced members share their tier’s total; extra seats show as unassigned."}
        </span>
      </div>

      {error && (
        <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>
      )}
      {saved && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{saved}</p>
      )}

      {mine.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-medium">Month</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 text-right font-medium">Seats</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {shown.map((e) => (
                  <tr key={`${e.seatType}:${e.month}`} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">{monthLabel(e.month)}</td>
                    <td className="px-3 py-2 text-muted">{TIER_LABEL[e.seatType] ?? e.seatType}</td>
                    <td className="px-3 py-2 text-right">{e.seats}</td>
                    <td className="px-3 py-2 text-right">
                      {e.priceGbp !== null ? <>{gbp(e.priceGbp)} <span className="text-muted">→ {formatUsd(e.priceUsd)}</span></> : formatUsd(e.priceUsd)}
                    </td>
                    <td className="px-3 py-2 text-right">{formatUsd(Math.round(e.seats * e.priceUsd * 100) / 100)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => onDelete(e.month, e.seatType)} disabled={pending}
                        aria-label={`Remove ${monthLabel(e.month)} ${TIER_LABEL[e.seatType] ?? e.seatType} seats`}
                        className="text-xs text-muted hover:text-pink-300 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mine.length > RECENT && (
            <button onClick={() => setShowAll((v) => !v)} className="text-xs text-accent hover:underline">
              {showAll ? "Show fewer" : `Show all ${VENDOR_LABEL[vendor]} entries (${mine.length})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
