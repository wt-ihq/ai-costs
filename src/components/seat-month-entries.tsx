"use client";

import { useState, useTransition } from "react";
import { saveSeatMonthEntries, deleteSeatMonthEntry, type SeatEntryInput } from "@/app/(dashboard)/imports/actions";
import { formatUsd } from "@/lib/utils";
import { VENDOR_LABEL } from "@/lib/types";
import type { TieredVendor } from "@/lib/ingest/seat-months";

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

const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  rate: string; // £→$, Claude only
}

export function SeatMonthEntries({ entries }: { entries: SeatMonthEntryRow[] }) {
  const initialMonth = new Date().toISOString().slice(0, 7);

  // Entries are newest-first (see page.tsx ordering), so `find` returns the latest.
  const latest = (v: string, t: string) => entries.find((e) => e.vendor === v && e.seatType === t);
  const savedFor = (v: string, t: string, m: string) => entries.find((e) => e.vendor === v && e.seatType === t && e.month === m);
  // Claude entries are edited in the £ they were entered in.
  const shownPrice = (e: SeatMonthEntryRow) => String(e.vendor === "claude_team" ? e.priceGbp ?? e.priceUsd : e.priceUsd);
  const prefillPrice = (v: string, t: string) => {
    const e = latest(v, t);
    return e ? shownPrice(e) : FALLBACK_PRICE[`${v}:${t}`];
  };
  const prefillRate = () => String(latest("claude_team", "standard")?.fxRate ?? latest("claude_team", "premium")?.fxRate ?? 1.27);

  // A vendor+month's saved values, or the prefill chain with seats left blank.
  const fieldsFor = (v: TieredVendor, m: string): TierFields => {
    const std = savedFor(v, "standard", m);
    const prem = savedFor(v, "premium", m);
    return {
      stdSeats: std ? String(std.seats) : "",
      stdPrice: std ? shownPrice(std) : prefillPrice(v, "standard"),
      premSeats: prem ? String(prem.seats) : "",
      premPrice: prem ? shownPrice(prem) : prefillPrice(v, "premium"),
      rate: v === "claude_team" ? String(std?.fxRate ?? prem?.fxRate ?? prefillRate()) : "",
    };
  };

  const [vendor, setVendor] = useState<TieredVendor>("chatgpt_business");
  const [month, setMonth] = useState(initialMonth);
  const [fields, setFields] = useState(() => fieldsFor("chatgpt_business", initialMonth));
  const setField = (k: keyof TierFields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [k]: e.target.value }));

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Switching vendor or month reloads that combo's saved values.
  const onVendor = (v: TieredVendor) => {
    setVendor(v);
    setFields(fieldsFor(v, month));
  };

  const onMonth = (m: string) => {
    setMonth(m);
    setFields(fieldsFor(vendor, m));
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

  const isClaude = vendor === "claude_team";
  const cur = isClaude ? "£" : "$";
  const hasInput = fields.stdSeats.trim() !== "" || fields.premSeats.trim() !== "";

  const onSave = () =>
    run(async () => {
      const inputs: SeatEntryInput[] = [];
      // A blank tier is left untouched; "0" pins that tier to zero seats.
      if (fields.stdSeats.trim() !== "") inputs.push({ seatType: "standard", seats: Number(fields.stdSeats), price: Number(fields.stdPrice) || 0 });
      if (fields.premSeats.trim() !== "") inputs.push({ seatType: "premium", seats: Number(fields.premSeats), price: Number(fields.premPrice) || 0 });
      const { written } = await saveSeatMonthEntries(month, vendor, inputs, isClaude ? Number(fields.rate) || 0 : null);
      setSaved(`Saved ${month} — ${written} facts written.`);
    });

  const onDelete = (v: string, m: string, t: string) =>
    run(async () => {
      const { written } = await deleteSeatMonthEntry(m, v as TieredVendor, t);
      setSaved(`Removed ${m} (${TIER_LABEL[t] ?? t}) — reverted to synced members × default price (${written} facts).`);
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          Vendor
          <select
            value={vendor}
            onChange={(e) => onVendor(e.target.value as TieredVendor)}
            className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
          >
            <option value="chatgpt_business">{VENDOR_LABEL.chatgpt_business}</option>
            <option value="claude_team">{VENDOR_LABEL.claude_team}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-muted">
          Month
          {/* Default is the client's local date; the server-rendered value can differ by a day. */}
          <input type="month" value={month} onChange={(e) => onMonth(e.target.value)} suppressHydrationWarning className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          Standard seats
          <input type="number" min="0" step="1" value={fields.stdSeats} onChange={setField("stdSeats")} className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <label className="flex items-center gap-2 text-muted">
          {cur} / standard
          <input type="number" min="0" step="0.01" value={fields.stdPrice} onChange={setField("stdPrice")} className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <label className="flex items-center gap-2 text-muted">
          Premium seats
          <input type="number" min="0" step="1" value={fields.premSeats} onChange={setField("premSeats")} className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <label className="flex items-center gap-2 text-muted">
          {cur} / premium
          <input type="number" min="0" step="0.01" value={fields.premPrice} onChange={setField("premPrice")} className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        {isClaude && (
          <label className="flex items-center gap-2 text-muted">
            £ → $ rate
            <input type="number" min="0" step="0.0001" value={fields.rate} onChange={setField("rate")} className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
          </label>
        )}
        <button
          onClick={onSave}
          disabled={pending || !month || !hasInput}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-accent disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save month"}
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>
      )}
      {saved && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{saved}</p>
      )}

      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Month</th>
                <th className="px-3 py-2 font-medium">Vendor</th>
                <th className="px-3 py-2 font-medium">Tier</th>
                <th className="px-3 py-2 text-right font-medium">Seats</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={`${e.vendor}:${e.seatType}:${e.month}`} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 font-medium">{e.month}</td>
                  <td className="px-3 py-2 text-muted">{VENDOR_LABEL[e.vendor as keyof typeof VENDOR_LABEL] ?? e.vendor}</td>
                  <td className="px-3 py-2 text-muted">{TIER_LABEL[e.seatType] ?? e.seatType}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.seats}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {e.priceGbp !== null ? `${gbp(e.priceGbp)} → ${formatUsd(e.priceUsd)}` : formatUsd(e.priceUsd)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUsd(Math.round(e.seats * e.priceUsd * 100) / 100)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => onDelete(e.vendor, e.month, e.seatType)} disabled={pending} className="text-xs text-pink-300 hover:underline disabled:opacity-40">
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
