"use client";

import { createContext, useContext, useState } from "react";

/**
 * Claude Team's £ → $ rate, entered once in its column header and used by both the spend paste and
 * the seat counts for a month that has none saved (a saved month keeps the rate it was saved with).
 * Starts from the latest ECB rate (else the last rate saved with a seat month).
 */
const FxRate = createContext<{ rate: string; setRate: (r: string) => void } | null>(null);

export function FxRateProvider({ initial, children }: { initial: string; children: React.ReactNode }) {
  const [rate, setRate] = useState(initial);
  return <FxRate.Provider value={{ rate, setRate }}>{children}</FxRate.Provider>;
}

/** The shared rate, or null outside a provider (ChatGPT, priced in $, has none). */
export const useFxRate = () => useContext(FxRate);

/** `note`: where the starting rate came from ("ECB, 16 Oct"), shown beside the field. */
export function FxRateField({ note }: { note?: string | null }) {
  const fx = useFxRate();
  if (!fx) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      £ → $ for spend and new seat months
      <input
        type="number" min="0" step="0.0001" value={fx.rate} onChange={(e) => fx.setRate(e.target.value)}
        className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
      />
      {note && <span className="text-muted">{note}</span>}
    </label>
  );
}
