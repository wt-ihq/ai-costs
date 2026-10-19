import { shortDay } from "@/lib/imports/checklist";

/**
 * The latest ECB reference rates, as USD per unit (run-ecb.ts stores them nightly). They prefill the
 * rate fields; an admin can still type another rate (an invoice's). Pure — safe for client code.
 */
export type FxCurrency = "GBP" | "EUR";
export interface EcbRate { rate: number; date: string } // date: the ECB's reference date
export type EcbRates = Partial<Record<FxCurrency, EcbRate>>;

/** "ECB, 16 Oct" */
export const ecbNote = (r: EcbRate): string => `ECB, ${shortDay(r.date)}`;
