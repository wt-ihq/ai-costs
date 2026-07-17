import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style className combiner. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const usdCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

/** Format a USD amount. Cents shown only below $100 where they matter. */
export function formatUsd(amount: number): string {
  return Math.abs(amount) < 100 ? usdCents.format(amount) : usd.format(amount);
}

const countFull = new Intl.NumberFormat("en-US");
const countCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Full count with thousands separators, e.g. "12,480". */
export function formatCount(n: number): string {
  return countFull.format(n);
}

/** "1 person" / "3 people". */
export function formatPeople(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** Compact count for tight spaces (axes), e.g. "12.5k". */
export function formatCountCompact(n: number): string {
  return countCompact.format(n);
}

/**
 * decodeURIComponent that survives malformed input (e.g. a hand-typed
 * `/explore/50%` URL) instead of throwing URIError → 500.
 */
export function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Today's date in the LOCAL timezone as YYYY-MM-DD. For user-facing "as of"
 * defaults — `toISOString()` is UTC, which rolls to tomorrow during a US
 * evening and, on a month boundary, snapshots an import into the wrong month.
 */
export function localDateISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "34 days old" style staleness label from a "data as of" date. */
export function staleness(asOf: Date, now: Date): string {
  const days = Math.floor((now.getTime() - asOf.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}
