import type { ShapeFact } from "@/lib/explore/shape";
import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import { NO_FIXED_COST_SETTINGS, type FixedCostSettings } from "./fixed-costs";
import type { SyncRunRow } from "./freshness";
import type { ManualImportRow } from "./readiness";
import { canRetakeClaim, MAX_SEND_ATTEMPTS, type NotifyStore, type SendKey } from "./store";
import type { Cadence, NotifyEmployee, ReportKind } from "./types";

/** In-memory NotifyStore for unit tests. Claim semantics share canRetakeClaim with the Supabase store. */
export interface SendRow extends SendKey {
  id?: string; // generated when absent
  status: string;
  attempts: number;
  slackTs: string | null;
  detail: string | null;
  updatedAt: string;
  openedAt?: string | null;
  dashboardLink?: boolean;
}

/** A seeded send row; `report` defaults to "personal" (rows written before the company report existed). */
export type SeedSendRow = Omit<SendRow, "report"> & { report?: ReportKind };

export interface MemorySeed {
  employees?: NotifyEmployee[];
  facts?: ShapeFact[];
  subscriptions?: { employeeId: string; cadence: Cadence }[];
  syncRuns?: SyncRunRow[];
  coverage?: CoverageMonthRow[];
  manualImports?: ManualImportRow[];
  sourceHorizons?: Record<string, string>;
  companyRecipients?: { employeeId: string; cadence: Cadence }[];
  sends?: SeedSendRow[];
  fixedCosts?: FixedCostSettings;
  /** dashboard_access emails. */
  dashboardAccess?: string[];
  /** Make dashboardAccess() throw (the table unreadable). */
  dashboardAccessFails?: boolean;
  /** Make everLive() throw (the send log unreadable). */
  everLiveFails?: boolean;
}

const same = (a: SendKey, b: SendKey) =>
  a.employeeId === b.employeeId && a.cadence === b.cadence && a.periodKey === b.periodKey && a.mode === b.mode && a.report === b.report;

export function memoryStore(seed: MemorySeed = {}, clock: () => number = Date.now) {
  let nextId = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
  const sends: SendRow[] = (seed.sends ?? []).map((s) => ({ ...s, id: s.id ?? newId(), report: s.report ?? "personal", openedAt: s.openedAt ?? null }));
  const slackUserCache = new Map<string, { slackUserId: string | null; tz: string | null; lookedUpAt: string }>();
  const factCalls: [string, string][] = [];
  const coverageCalls: string[] = [];
  const nowIso = () => new Date(clock()).toISOString();

  const store: NotifyStore & {
    sends: SendRow[];
    slackUserCache: typeof slackUserCache;
    factCalls: typeof factCalls;
    coverageCalls: typeof coverageCalls;
    failNextFinish: boolean;
  } = {
    sends,
    slackUserCache,
    factCalls,
    coverageCalls,
    failNextFinish: false,
    async subscriptions(cadences) {
      return (seed.subscriptions ?? []).filter((s) => cadences.includes(s.cadence));
    },
    async companyRecipients(cadences) {
      return (seed.companyRecipients ?? []).filter((s) => cadences.includes(s.cadence));
    },
    async employees() {
      return seed.employees ?? [];
    },
    async facts(from, toExclusive) {
      factCalls.push([from, toExclusive]);
      return (seed.facts ?? []).filter((f) => f.day >= from && f.day < toExclusive);
    },
    sourceHorizons: async () => seed.sourceHorizons ?? {},
    toolColors: async () => ({}),
    recentSyncRuns: async (since) => (seed.syncRuns ?? []).filter((r) => r.startedAt >= since),
    fixedCostSettings: async () => seed.fixedCosts ?? NO_FIXED_COST_SETTINGS,
    async dashboardAccess() {
      if (seed.dashboardAccessFails) throw new Error("dashboard_access: simulated outage");
      return new Set(seed.dashboardAccess ?? []);
    },
    manualImports: async (since) => (seed.manualImports ?? []).filter((r) => r.dataAsOf >= since),
    async importCoverage(nowMonth) {
      coverageCalls.push(nowMonth);
      return seed.coverage ?? [];
    },
    async everLive(ids) {
      if (seed.everLiveFails) throw new Error("notification_sends: simulated outage");
      return new Set(
        sends
          .filter((s) => s.mode === "live" && ids.includes(s.employeeId) && (s.status === "sent" || s.status === "pending" || s.detail === "interrupted"))
          .map((s) => s.employeeId),
      );
    },
    async sendStates(periodKeys, mode) {
      return sends.filter((s) => periodKeys.includes(s.periodKey) && s.mode === mode).map((s) => ({ ...s }));
    },
    async claimSend(key) {
      const existing = sends.find((s) => same(s, key));
      if (!existing) {
        const id = newId();
        sends.push({ ...key, id, status: "pending", attempts: 1, slackTs: null, detail: null, updatedAt: nowIso(), openedAt: null });
        return id;
      }
      if (!canRetakeClaim(existing)) return null;
      Object.assign(existing, { status: "pending", attempts: existing.attempts + 1, detail: null, updatedAt: nowIso() });
      return existing.id!;
    },
    async markOpened(sendId) {
      const row = sends.find((s) => s.id === sendId);
      if (!row) return null;
      row.openedAt ??= nowIso();
      const e = (seed.employees ?? []).find((x) => x.id === row.employeeId);
      return { employeeId: row.employeeId, department: e?.department ?? null, report: row.report };
    },
    async finishSend(key, r) {
      if (store.failNextFinish) {
        store.failNextFinish = false;
        throw new Error("finishSend: simulated DB outage");
      }
      const row = sends.find((s) => same(s, key));
      if (row) Object.assign(row, { status: r.status, slackTs: r.slackTs ?? null, detail: r.detail ?? null, updatedAt: nowIso(), ...(r.dashboardLink !== undefined ? { dashboardLink: r.dashboardLink } : {}) });
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
    async saveSlackUser(id, user) {
      slackUserCache.set(id, { slackUserId: user?.id ?? null, tz: user?.tz ?? null, lookedUpAt: nowIso() });
    },
  };
  return store;
}
