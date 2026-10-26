import type { SupabaseClient } from "@supabase/supabase-js";
import { LAST_UPDATED_SIGNAL, lastUpdatedFrom, type LastUpdated } from "@/lib/explore/last-updated";
import type { Vendor } from "@/lib/types";

/**
 * vendor → the day it was last refreshed, for Explore's Breakdown badges. One
 * LIMIT-1 query per vendor (never a whole-table read: sync_runs grows daily ×
 * sources — gotcha #1). Automatic sources count only their last *successful*
 * run, so a stuck or failed night shows the last good date rather than nothing.
 * A failed read throws — "never updated" must never be a lie.
 */
export async function getLastUpdated(supabase: SupabaseClient): Promise<LastUpdated> {
  const syncs: Record<string, string | null> = {};
  const imports: Record<string, string | null> = {};
  await Promise.all(
    (Object.keys(LAST_UPDATED_SIGNAL) as Vendor[]).map(async (vendor) => {
      const { table, source } = LAST_UPDATED_SIGNAL[vendor];
      if (table === "sync_runs") {
        const { data, error } = await supabase
          .from("sync_runs")
          .select("finished_at")
          .eq("source", source)
          .eq("status", "success")
          .order("finished_at", { ascending: false })
          .limit(1);
        if (error) throw new Error(`getLastUpdated (sync_runs/${source}): ${error.message}`);
        syncs[source] = (data?.[0]?.finished_at as string | undefined) ?? null;
      } else {
        const { data, error } = await supabase
          .from("imports")
          .select("data_as_of")
          .eq("source", source)
          .order("data_as_of", { ascending: false })
          .limit(1);
        if (error) throw new Error(`getLastUpdated (imports/${source}): ${error.message}`);
        imports[source] = (data?.[0]?.data_as_of as string | undefined) ?? null;
      }
    }),
  );
  return lastUpdatedFrom(syncs, imports);
}
