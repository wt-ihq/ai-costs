import { SchemaDriftError } from "@/lib/ingest/types";

/**
 * ECB euro foreign exchange reference rates (eurofxref-daily.xml): one reference date, then each
 * currency's rate per euro. Published around 16:00 CET on TARGET working days.
 */
export interface EcbDaily {
  date: string; // YYYY-MM-DD, the ECB's reference date
  perEur: Record<string, number>;
}

export function parseEcbDaily(xml: string): EcbDaily {
  const date = xml.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
  if (!date) throw new SchemaDriftError("ecb", "no reference date in the daily rates file");
  const perEur: Record<string, number> = {};
  for (const m of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) perEur[m[1]] = Number(m[2]);
  if (Object.keys(perEur).length === 0) throw new SchemaDriftError("ecb", "no rates in the daily rates file");
  return { date, perEur };
}

/** The currencies the dashboard converts from (recurring costs, Claude Team), as USD per unit. */
export type FxCurrency = "GBP" | "EUR";
export interface UsdRate { currency: FxCurrency; usdPerUnit: number; date: string }

const six = (n: number) => Math.round(n * 1e6) / 1e6;
const valid = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Dollars per pound (USD/EUR ÷ GBP/EUR) and per euro. Throws rather than store a rate built from a missing one. */
export function ecbUsdRates({ date, perEur }: EcbDaily): UsdRate[] {
  const usd = perEur.USD;
  const gbp = perEur.GBP;
  if (!valid(usd)) throw new SchemaDriftError("ecb", "no USD rate");
  if (!valid(gbp)) throw new SchemaDriftError("ecb", "no GBP rate");
  return [
    { currency: "GBP", usdPerUnit: six(usd / gbp), date },
    { currency: "EUR", usdPerUnit: six(usd), date },
  ];
}
