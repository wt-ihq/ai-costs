import { unstable_cache } from "next/cache";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCompanyScope, getPersonScope, getSearchIndex, getTeamScope } from "./explore";
import { packScope } from "@/lib/explore/build";
import { rollUpScope } from "@/lib/explore/rollup";
import { getApiPlatformsScope, packApiPlatformsScope } from "./api-platforms";
import { getDataHealth } from "./data-health";
import { getImportCoverageScope } from "./import-coverage";
import { getModelUsageScope } from "./cursor-models";
import { getPersonCursorUsageScope, getTeamCursorUsageScope } from "./cursor-usage";
import { getCursorTopModelScope } from "./cursor-top-model";
import { getCursorSpendScope } from "./cursor-spend";
import { getOpenRouterScope } from "./openrouter";
import { loadRecommendations } from "@/lib/recommendations/load";
import { getCursorReconciliation, type CursorReconciliation } from "./cursor-reconciliation";

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
const CACHE_VERSION = "v10"; // v10: company and team scopes are rolled up (model and key blanked where unread); API platforms scope added

const OPTS = { tags: [FACTS_TAG], revalidate: 3600 };

/**
 * Diagnostic wrapper: a "[cache] MISS <name> …" line logs only when the
 * cached function body actually executes; the outer line always logs total
 * time. A HIT therefore shows as a fast total with no MISS line — and the
 * payload size tells us whether entries exceed the data-cache item cap
 * (which silently disables caching). Cheap enough to keep permanently.
 */
function instrumented<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>, keyParts: string[], opts = OPTS) {
  const cached = unstable_cache(
    async (...args: A) => {
      const t0 = Date.now();
      const result = await fn(...args);
      const bytes = Buffer.byteLength(JSON.stringify(result));
      console.log(`[cache] MISS ${name} computed=${Date.now() - t0}ms size=${(bytes / 1024).toFixed(0)}kB`);
      return result;
    },
    keyParts,
    opts,
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
// Company and team scopes are also ROLLED UP first (explore/rollup.ts): rows those
// pages can't tell apart are summed into one, so far fewer rows are cached, sent
// and re-added in the browser. The person scope keeps every row (its line items).
// Postgres does that summing when migration 0030's function is there (one response, not every
// raw row); rollUpScope then changes nothing, and is the whole roll-up when it isn't.
export const getCompanyScopeCached = instrumented(
  "scope-company",
  async () => packScope(rollUpScope(await getCompanyScope(getSupabaseAdminClient()))),
  ["scope-company", CACHE_VERSION],
);

export const getTeamScopeCached = instrumented(
  "scope-team",
  async (team: string) => packScope(rollUpScope(await getTeamScope(getSupabaseAdminClient(), team))),
  ["scope-team", CACHE_VERSION],
);

export const getPersonScopeCached = instrumented(
  "scope-person",
  async (employeeId: string) => packScope(await getPersonScope(getSupabaseAdminClient(), employeeId)),
  ["scope-person", CACHE_VERSION],
);

export const getTeamCursorUsageCached = instrumented(
  "team-cursor-usage",
  async () => getTeamCursorUsageScope(getSupabaseAdminClient()),
  ["team-cursor-usage", CACHE_VERSION],
);

export const getPersonCursorUsageCached = instrumented(
  "person-cursor-usage",
  async (employeeId: string) => getPersonCursorUsageScope(getSupabaseAdminClient(), employeeId),
  ["person-cursor-usage", CACHE_VERSION],
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

export const getOpenRouterScopeCached = instrumented(
  "openrouter-scope",
  async () => getOpenRouterScope(getSupabaseAdminClient()),
  ["openrouter-scope", CACHE_VERSION],
);

// Every metered fact on record, read on each view until this was cached (it was the one data
// page still fetched raw). Metered syncs and imports already bust FACTS_TAG.
export const getApiPlatformsScopeCached = instrumented(
  "api-platforms",
  async () => packApiPlatformsScope(await getApiPlatformsScope(getSupabaseAdminClient())),
  ["api-platforms", CACHE_VERSION],
);

export const getRecommendationsCached = instrumented(
  "recommendations",
  async () => loadRecommendations(getSupabaseAdminClient(), new Date()),
  ["recommendations", CACHE_VERSION],
);

// Data → Health's Cursor reconciliation calls Cursor's own API (a request per 100 members) and
// then pages this billing cycle's on-demand facts — on every view of the Data page until it was
// cached. Our side changes only when a sync or rebuild busts FACTS_TAG; Cursor's side moves all
// day, so this entry is refreshed every 15 minutes rather than hourly. A failed check (null) is
// thrown inside the cache so it is never stored: the next view simply tries again.
const cursorReconciliationCached = instrumented(
  "cursor-reconciliation",
  async (): Promise<CursorReconciliation> => {
    const result = await getCursorReconciliation(getSupabaseAdminClient());
    if (!result) throw new Error("cursor reconciliation unavailable");
    return result;
  },
  ["cursor-reconciliation", CACHE_VERSION],
  { tags: [FACTS_TAG], revalidate: 900 },
);

/** The reconciliation, or null when the Cursor key is absent or the check failed (the panel is then hidden). */
export async function getCursorReconciliationCached(): Promise<CursorReconciliation | null> {
  try {
    return await cursorReconciliationCached();
  } catch {
    return null;
  }
}
