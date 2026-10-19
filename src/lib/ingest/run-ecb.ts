import type { SupabaseClient } from "@supabase/supabase-js";
import { ecbUsdRates, parseEcbDaily } from "@/lib/ingest/normalizers/ecb";
import { fetchEcbDaily, type EcbFetcher } from "@/lib/ingest/sources/ecb";
import { finishSyncRun, saveRawPayload, startSyncRun } from "@/lib/ingest/persist";

/**
 * Nightly: the ECB's latest reference rates → fx_rates (source 'ecb'), as USD per pound and per
 * euro, dated with the ECB's reference date. Rerunning the same day rewrites the same rows. They
 * prefill the rate fields (Imports → Claude Team, Tools → recurring costs); nothing already saved
 * is re-priced. A failure leaves the last stored rates in use.
 */
export async function syncEcb(supabase: SupabaseClient, fetcher: EcbFetcher = fetchEcbDaily): Promise<{ rowsWritten: number }> {
  const runId = await startSyncRun(supabase, "ecb");
  try {
    const xml = await fetcher();
    await saveRawPayload(supabase, "ecb", runId, { xml });
    const rates = ecbUsdRates(parseEcbDaily(xml));
    const { error } = await supabase.from("fx_rates").upsert(
      rates.map((r) => ({ currency: r.currency, usd_per_unit: r.usdPerUnit, effective_from: r.date, source: "ecb" })),
      { onConflict: "currency,effective_from" },
    );
    if (error) throw new Error(`fx_rates: ${error.message}`);
    await finishSyncRun(supabase, runId, { status: "success", rowsWritten: rates.length });
    return { rowsWritten: rates.length };
  } catch (err) {
    await finishSyncRun(supabase, runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
