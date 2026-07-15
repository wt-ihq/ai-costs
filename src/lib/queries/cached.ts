import { unstable_cache } from "next/cache";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCompanyScope, getPersonScope, getSearchIndex, getTeamScope } from "./explore";
import { getDataHealth } from "./data-health";
import { getImportCoverageScope } from "./import-coverage";

/**
 * Single invalidation tag for every derived-from-spend-facts read. The data
 * changes only via the daily cron and admin imports/entries — each write path
 * calls `revalidateTag(FACTS_TAG)`, so pages serve a warm cache between
 * writes instead of re-paginating the whole facts table per view. The hourly
 * `revalidate` is a safety net for any missed bust (and for the fact window's
 * `new Date()` month boundary — the 06:00 UTC cron busts right after
 * rollover anyway).
 *
 * Oversized entries (Vercel caps data-cache items) silently skip caching and
 * fall back to a live fetch — worst case is exactly today's behavior.
 */
export const FACTS_TAG = "facts";

const OPTS = { tags: [FACTS_TAG], revalidate: 3600 };

export const getCompanyScopeCached = unstable_cache(
  async () => getCompanyScope(getSupabaseAdminClient()),
  ["scope-company"],
  OPTS,
);

export const getTeamScopeCached = unstable_cache(
  async (team: string) => getTeamScope(getSupabaseAdminClient(), team),
  ["scope-team"],
  OPTS,
);

export const getPersonScopeCached = unstable_cache(
  async (employeeId: string) => getPersonScope(getSupabaseAdminClient(), employeeId),
  ["scope-person"],
  OPTS,
);

export const getSearchIndexCached = unstable_cache(
  async () => getSearchIndex(getSupabaseAdminClient()),
  ["search-index"],
  OPTS,
);

export const getDataHealthCached = unstable_cache(
  async () => getDataHealth(getSupabaseAdminClient()),
  ["data-health"],
  OPTS,
);

export const getImportCoverageScopeCached = unstable_cache(
  async () => getImportCoverageScope(getSupabaseAdminClient()),
  ["import-coverage"],
  OPTS,
);
