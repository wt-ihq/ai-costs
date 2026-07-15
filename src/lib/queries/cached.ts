import { unstable_cache } from "next/cache";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCompanyScope, getPersonScope, getSearchIndex, getTeamScope } from "./explore";
import { packScope } from "@/lib/explore/build";
import { getDataHealth } from "./data-health";
import { getImportCoverageScope } from "./import-coverage";
import { getModelUsageScope } from "./cursor-models";
import { getCursorTopModelScope } from "./cursor-top-model";
import { getCursorSpendScope } from "./cursor-spend";

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

/**
 * Cache-key version — MUST be bumped whenever the SHAPE of any cached value
 * changes. unstable_cache entries survive deployments, so without a version
 * bump a new build can read an old-shaped entry and crash (this bit us when
 * scopes switched to the packed format).
 */
const CACHE_VERSION = "v2";

const OPTS = { tags: [FACTS_TAG], revalidate: 3600 };

/**
 * Diagnostic wrapper: a "[cache] MISS <name> …" line logs only when the
 * cached function body actually executes; the outer line always logs total
 * time. A HIT therefore shows as a fast total with no MISS line — and the
 * payload size tells us whether entries exceed the data-cache item cap
 * (which silently disables caching). Cheap enough to keep permanently.
 */
function instrumented<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>, keyParts: string[]) {
  const cached = unstable_cache(
    async (...args: A) => {
      const t0 = Date.now();
      const result = await fn(...args);
      const bytes = Buffer.byteLength(JSON.stringify(result));
      console.log(`[cache] MISS ${name} computed=${Date.now() - t0}ms size=${(bytes / 1024).toFixed(0)}kB`);
      return result;
    },
    keyParts,
    OPTS,
  );
  return async (...args: A): Promise<R> => {
    const t0 = Date.now();
    const result = await cached(...args);
    console.log(`[cache] ${name} total=${Date.now() - t0}ms`);
    return result;
  };
}

// Scopes are cached (and shipped to the client) in PACKED form — the raw
// company scope's 1.9MB exceeded the data-cache item cap, silently disabling
// caching, and every byte here is also RSC payload the browser must download.
export const getCompanyScopeCached = instrumented(
  "scope-company",
  async () => packScope(await getCompanyScope(getSupabaseAdminClient())),
  ["scope-company", CACHE_VERSION],
);

export const getTeamScopeCached = instrumented(
  "scope-team",
  async (team: string) => packScope(await getTeamScope(getSupabaseAdminClient(), team)),
  ["scope-team", CACHE_VERSION],
);

export const getPersonScopeCached = instrumented(
  "scope-person",
  async (employeeId: string) => packScope(await getPersonScope(getSupabaseAdminClient(), employeeId)),
  ["scope-person", CACHE_VERSION],
);

export const getSearchIndexCached = instrumented(
  "search-index",
  async () => getSearchIndex(getSupabaseAdminClient()),
  ["search-index", CACHE_VERSION],
);

export const getDataHealthCached = instrumented(
  "data-health",
  async () => getDataHealth(getSupabaseAdminClient()),
  ["data-health", CACHE_VERSION],
);

export const getImportCoverageScopeCached = instrumented(
  "import-coverage",
  async () => getImportCoverageScope(getSupabaseAdminClient()),
  ["import-coverage", CACHE_VERSION],
);

// Cursor usage page readers — all rebuilt by the nightly cron (which busts
// FACTS_TAG), so they cache exactly like the explore scopes.
export const getModelUsageScopeCached = instrumented(
  "cursor-model-usage",
  async () => getModelUsageScope(getSupabaseAdminClient()),
  ["cursor-model-usage", CACHE_VERSION],
);

export const getCursorTopModelScopeCached = instrumented(
  "cursor-top-model",
  async () => getCursorTopModelScope(getSupabaseAdminClient()),
  ["cursor-top-model", CACHE_VERSION],
);

export const getCursorSpendScopeCached = instrumented(
  "cursor-spend",
  async () => getCursorSpendScope(getSupabaseAdminClient()),
  ["cursor-spend", CACHE_VERSION],
);
