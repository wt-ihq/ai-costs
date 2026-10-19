import type { SupabaseClient } from "@supabase/supabase-js";
import type { EcbRates, FxCurrency } from "@/lib/fx";

/**
 * The newest ECB rate per currency (fx_rates, source 'ecb'). Best effort: an unreadable table (e.g.
 * before migration 0023) returns what it could, and the fields fall back to their old prefills.
 */
export async function latestEcbRates(supabase: SupabaseClient): Promise<EcbRates> {
  const out: EcbRates = {};
  await Promise.all(
    (["GBP", "EUR"] as FxCurrency[]).map(async (currency) => {
      const { data, error } = await supabase
        .from("fx_rates")
        .select("usd_per_unit, effective_from")
        .eq("currency", currency)
        .eq("source", "ecb")
        .order("effective_from", { ascending: false })
        .limit(1);
      if (error) {
        console.warn(`latestEcbRates(${currency}): ${error.message}`);
        return;
      }
      const row = data?.[0];
      if (row) out[currency] = { rate: Number(row.usd_per_unit), date: row.effective_from as string };
    }),
  );
  return out;
}
