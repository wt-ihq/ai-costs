import type { ShapeFact } from "@/lib/explore/shape";
import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import type { SyncRunRow } from "./freshness";
import { canRetakeClaim, MAX_SEND_ATTEMPTS, type NotifyStore, type SendKey } from "./store";
import type { Cadence, NotifyEmployee } from "./types";

/** In-memory NotifyStore for unit tests. Claim semantics share canRetakeClaim with the Supabase store. */
export interface SendRow extends SendKey {
  status: string;
  attempts: number;
  slackTs: string | null;
  detail: string | null;
  updatedAt: string;
}

export interface MemorySeed {
  employees?: NotifyEmployee[];
  facts?: ShapeFact[];
  subscriptions?: { employeeId: string; cadence: Cadence }[];
  syncRuns?: SyncRunRow[];
  coverage?: CoverageMonthRow[];
  sourceHorizons?: Record<string, string>;
  usageHorizons?: Record<string, string>;
  sends?: SendRow[];
}

const same = (a: SendKey, b: SendKey) =>
  a.employeeId === b.employeeId && a.cadence === b.cadence && a.periodKey === b.periodKey && a.mode === b.mode;

export function memoryStore(seed: MemorySeed = {}, clock: () => number = Date.now) {
  const sends: SendRow[] = [...(seed.sends ?? [])];
  const slackUserCache = new Map<string, { slackUserId: string | null; lookedUpAt: string }>();
  const factCalls: [string, string][] = [];
  const nowIso = () => new Date(clock()).toISOString();

  const store: NotifyStore & {
    sends: SendRow[];
    slackUserCache: typeof slackUserCache;
    factCalls: typeof factCalls;
    failNextFinish: boolean;
  } = {
    sends,
    slackUserCache,
    factCalls,
    failNextFinish: false,
    async subscriptions(cadences) {
      return (seed.subscriptions ?? []).filter((s) => cadences.includes(s.cadence));
    },
    async employees() {
      return seed.employees ?? [];
    },
    async facts(from, toExclusive) {
      factCalls.push([from, toExclusive]);
      return (seed.facts ?? []).filter((f) => f.day >= from && f.day < toExclusive);
    },
    sourceHorizons: async () => seed.sourceHorizons ?? {},
    usageHorizons: async () => seed.usageHorizons ?? {},
    toolColors: async () => ({}),
    recentSyncRuns: async (since) => (seed.syncRuns ?? []).filter((r) => r.startedAt >= since),
    importCoverage: async () => seed.coverage ?? [],
    async claimSend(key) {
      const existing = sends.find((s) => same(s, key));
      if (!existing) {
        sends.push({ ...key, status: "pending", attempts: 1, slackTs: null, detail: null, updatedAt: nowIso() });
        return true;
      }
      if (!canRetakeClaim(existing)) return false;
      Object.assign(existing, { status: "pending", attempts: existing.attempts + 1, detail: null, updatedAt: nowIso() });
      return true;
    },
    async finishSend(key, r) {
      if (store.failNextFinish) {
        store.failNextFinish = false;
        throw new Error("finishSend: simulated DB outage");
      }
      const row = sends.find((s) => same(s, key));
      if (row) Object.assign(row, { status: r.status, slackTs: r.slackTs ?? null, detail: r.detail ?? null, updatedAt: nowIso() });
    },
    async expireStalePending(olderThan) {
      let n = 0;
      for (const s of sends) {
        if (s.status === "pending" && s.updatedAt < olderThan) {
          Object.assign(s, { status: "failed", detail: "interrupted", attempts: MAX_SEND_ATTEMPTS, updatedAt: nowIso() });
          n++;
        }
      }
      return n;
    },
    async slackUser(id) {
      return slackUserCache.get(id) ?? null;
    },
    async saveSlackUser(id, slackUserId) {
      slackUserCache.set(id, { slackUserId, lookedUpAt: nowIso() });
    },
  };
  return store;
}
