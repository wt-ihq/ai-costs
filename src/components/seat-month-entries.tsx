"use client";

import { useState, useTransition } from "react";
import { saveSeatMonthEntries, deleteSeatMonthEntry, type SeatEntryInput } from "@/app/(dashboard)/imports/actions";
import { formatUsd } from "@/lib/utils";
import { VENDOR_LABEL } from "@/lib/types";

export interface SeatMonthEntryRow {
  vendor: string; // 'chatgpt_business' | 'claude_team'
  seatType: string; // 'chatgpt' | 'standard' | 'premium'
  month: string; // YYYY-MM
  seats: number;
  priceUsd: number;
  priceGbp: number | null;
  fxRate: number | null;
}

type SeatVendor = "chatgpt_business" | "claude_team";

const TIER_LABEL: Record<string, string> = { chatgpt: "ChatGPT", standard: "Standard", premium: "Premium" };

const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FALLBACK: Record<string, { price: string; rate: string }> = {
  "chatgpt_business:chatgpt": { price: "25", rate: "" },
  "claude_team:standard": { price: "15", rate: "1.27" },
  "claude_team:premium": { price: "75", rate: "1.27" },
};

export function SeatMonthEntries({ entries }: { entries: SeatMonthEntryRow[] }) {
  const initialMonth = new Date().toISOString().slice(0, 7);

  // Entries are newest-first (see page.tsx ordering), so `find` returns the latest.
  const latest = (v: string, t: string) => entries.find((e) => e.vendor === v && e.seatType === t);
  const savedFor = (v: string, t: string, m: string) => entries.find((e) => e.vendor === v && e.seatType === t && e.month === m);
  const prefillPrice = (v: string, t: string) => {
    const e = latest(v, t);
    if (!e) return FALLBACK[`${v}:${t}`].price;
    return String(v === "claude_team" ? e.priceGbp ?? e.priceUsd : e.priceUsd);
  };
  const prefillRate = () => String(latest("claude_team", "standard")?.fxRate ?? latest("claude_team", "premium")?.fxRate ?? 1.27);

  const [vendor, setVendor] = useState<SeatVendor>("chatgpt_business");
  const [month, setMonth] = useState(initialMonth);

  // ChatGPT tier.
  const [seats, setSeats] = useState(() => {
    const e = savedFor("chatgpt_business", "chatgpt", initialMonth);
    return e ? String(e.seats) : "";
  });
  const [price, setPrice] = useState(() => {
    const e = savedFor("chatgpt_business", "chatgpt", initialMonth);
    return e ? String(e.priceUsd) : prefillPrice("chatgpt_business", "chatgpt");
  });

  // Claude tiers (standard + premium) + one shared £→$ rate.
  const [stdSeats, setStdSeats] = useState(() => {
    const e = savedFor("claude_team", "standard", initialMonth);
    return e ? String(e.seats) : "";
  });
  const [stdPrice, setStdPrice] = useState(() => {
    const e = savedFor("claude_team", "standard", initialMonth);
    return e ? String(e.priceGbp ?? e.priceUsd) : prefillPrice("claude_team", "standard");
  });
  const [premSeats, setPremSeats] = useState(() => {
    const e = savedFor("claude_team", "premium", initialMonth);
    return e ? String(e.seats) : "";
  });
  const [premPrice, setPremPrice] = useState(() => {
    const e = savedFor("claude_team", "premium", initialMonth);
    return e ? String(e.priceGbp ?? e.priceUsd) : prefillPrice("claude_team", "premium");
  });
  const [rate, setRate] = useState(() => {
    const std = savedFor("claude_team", "standard", initialMonth);
    const prem = savedFor("claude_team", "premium", initialMonth);
    return String(std?.fxRate ?? prem?.fxRate ?? prefillRate());
  });

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const loadChatgpt = (m: string) => {
    const e = savedFor("chatgpt_business", "chatgpt", m);
    setSeats(e ? String(e.seats) : "");
    setPrice(e ? String(e.priceUsd) : prefillPrice("chatgpt_business", "chatgpt"));
  };

  const loadClaude = (m: string) => {
    const std = savedFor("claude_team", "standard", m);
    const prem = savedFor("claude_team", "premium", m);
    setStdSeats(std ? String(std.seats) : "");
    setStdPrice(std ? String(std.priceGbp ?? std.priceUsd) : prefillPrice("claude_team", "standard"));
    setPremSeats(prem ? String(prem.seats) : "");
    setPremPrice(prem ? String(prem.priceGbp ?? prem.priceUsd) : prefillPrice("claude_team", "premium"));
    setRate(String(std?.fxRate ?? prem?.fxRate ?? prefillRate()));
  };

  // Switching vendor or month reloads that combo's saved values (or the prefill chain, seats left blank).
  const onVendor = (v: SeatVendor) => {
    setVendor(v);
    if (v === "claude_team") loadClaude(month);
    else loadChatgpt(month);
  };

  const onMonth = (m: string) => {
    setMonth(m);
    if (vendor === "claude_team") loadClaude(m);
    else loadChatgpt(m);
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
  const hasInput = isClaude ? stdSeats.trim() !== "" || premSeats.trim() !== "" : seats.trim() !== "";

  const onSave = () =>
    run(async () => {
      const inputs: SeatEntryInput[] = [];
      if (isClaude) {
        // A blank tier is left untouched; "0" pins that tier to zero seats.
        if (stdSeats.trim() !== "") inputs.push({ seatType: "standard", seats: Number(stdSeats), price: Number(stdPrice) || 0 });
        if (premSeats.trim() !== "") inputs.push({ seatType: "premium", seats: Number(premSeats), price: Number(premPrice) || 0 });
      } else {
        inputs.push({ seatType: "chatgpt", seats: Number(seats), price: Number(price) || 0 });
      }
      const { written } = await saveSeatMonthEntries(month, vendor, inputs, isClaude ? Number(rate) || 0 : null);
      setSaved(`Saved ${month} — ${written} facts written.`);
    });

  const onDelete = (v: string, m: string, t: string) =>
    run(async () => {
      const { written } = await deleteSeatMonthEntry(m, v as SeatVendor, t);
      setSaved(`Removed ${m} (${TIER_LABEL[t] ?? t}) — reverted to synced members × default price (${written} facts).`);
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          Vendor
          <select
            value={vendor}
            onChange={(e) => onVendor(e.target.value as SeatVendor)}
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
        {isClaude ? (
          <>
            <label className="flex items-center gap-2 text-muted">
              Standard seats
              <input type="number" min="0" step="1" value={stdSeats} onChange={(e) => setStdSeats(e.target.value)} className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
            </label>
            <label className="flex items-center gap-2 text-muted">
              £ / standard
              <input type="number" min="0" step="0.01" value={stdPrice} onChange={(e) => setStdPrice(e.target.value)} className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
            </label>
            <label className="flex items-center gap-2 text-muted">
              Premium seats
              <input type="number" min="0" step="1" value={premSeats} onChange={(e) => setPremSeats(e.target.value)} className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
            </label>
            <label className="flex items-center gap-2 text-muted">
              £ / premium
              <input type="number" min="0" step="0.01" value={premPrice} onChange={(e) => setPremPrice(e.target.value)} className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
            </label>
            <label className="flex items-center gap-2 text-muted">
              £ → $ rate
              <input type="number" min="0" step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
            </label>
          </>
        ) : (
          <>
            <label className="flex items-center gap-2 text-muted">
              Seats
              <input type="number" min="0" step="1" value={seats} onChange={(e) => setSeats(e.target.value)} className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
            </label>
            <label className="flex items-center gap-2 text-muted">
              $ / seat
              <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent" />
            </label>
          </>
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
