"use client";

import { useState, useTransition } from "react";
import { saveSeatMonthEntry, deleteSeatMonthEntry } from "@/app/(dashboard)/imports/actions";
import { formatUsd } from "@/lib/utils";

export interface SeatMonthEntryRow {
  month: string; // YYYY-MM
  seats: number;
  priceUsd: number;
}

export function SeatMonthEntries({ entries }: { entries: SeatMonthEntryRow[] }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [seats, setSeats] = useState("");
  const [price, setPrice] = useState("25");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Selecting a month with a saved entry prefills its values for editing.
  const onMonth = (m: string) => {
    setMonth(m);
    const existing = entries.find((e) => e.month === m);
    setSeats(existing ? String(existing.seats) : "");
    setPrice(existing ? String(existing.priceUsd) : "25");
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

  const onSave = () =>
    run(async () => {
      const { written } = await saveSeatMonthEntry(month, Number(seats), Number(price) || 0);
      setSaved(`Saved ${month}: ${seats} seats × ${formatUsd(Number(price) || 0)} — ${written} facts written.`);
    });

  const onDelete = (m: string) =>
    run(async () => {
      const { written } = await deleteSeatMonthEntry(m);
      setSaved(`Removed ${m} — reverted to pasted members × default price (${written} facts).`);
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          Month
          {/* Default is the client's local date; the server-rendered value can differ by a day. */}
          <input type="month" value={month} onChange={(e) => onMonth(e.target.value)} suppressHydrationWarning className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <label className="flex items-center gap-2 text-muted">
          Seats
          <input type="number" min="0" step="1" value={seats} onChange={(e) => setSeats(e.target.value)} className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <label className="flex items-center gap-2 text-muted">
          $ / seat
          <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
        </label>
        <button
          onClick={onSave}
          disabled={pending || !month || seats.trim() === ""}
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
                <th className="px-3 py-2 text-right font-medium">Seats</th>
                <th className="px-3 py-2 text-right font-medium">$ / seat</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.month} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 font-medium">{e.month}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.seats}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUsd(e.priceUsd)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUsd(Math.round(e.seats * e.priceUsd * 100) / 100)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => onDelete(e.month)} disabled={pending} className="text-xs text-pink-300 hover:underline disabled:opacity-40">
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
