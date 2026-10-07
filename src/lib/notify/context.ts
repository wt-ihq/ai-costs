import type { ShapeFact } from "@/lib/explore/shape";
import type { CoverageMonthRow } from "@/lib/queries/import-coverage";
import { buildDigest, buildTeamDigest, type Digest, type SectionInput, type TeamDigest } from "./digest";
import { fixedCostsFor, fixedCostsForTeam, type FixedCostSettings } from "./fixed-costs";
import { monthlyReadiness, sourceFreshness, type SourceFreshness, type SyncRunRow } from "./freshness";
import type { DigestPeriod } from "./schedule";
import type { NotifyStore } from "./store";
import { buildReportingTree, type ReportingTree } from "./tree";
import type { NotifyEmployee } from "./types";

export interface NotifyContext {
  now: Date;
  baseUrl: string;
  employees: NotifyEmployee[];
  employeesById: Map<string, NotifyEmployee>;
  tree: ReportingTree;
  facts: ShapeFact[];
  sourceHorizons: Record<string, string>;
  toolColors: Record<string, string>;
  freshness: SourceFreshness[];
  coverage: CoverageMonthRow[];
  syncRuns: SyncRunRow[];
  fixedCosts: FixedCostSettings;
}

/** 6-month monthly charts + the month before + projection history (trend lookback ≤ 4 complete months). */
export const HISTORY_MONTHS = 7;

export function factsWindow(now: Date, earliest?: string): { from: string; toExclusive: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - HISTORY_MONTHS, 1)).toISOString().slice(0, 10);
  const toExclusive = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  return { from: earliest && earliest < from ? earliest : from, toExclusive };
}

/** Yesterday 00:00 UTC — enough runs to know each source's latest outcome. */
export function syncRunsSince(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString();
}

/** Load everything a run (or a preview) needs ONCE: one fact read, split per recipient in memory. */
export async function loadNotifyContext(
  store: NotifyStore,
  now: Date,
  baseUrl: string,
  opts: { earliest?: string; coverage?: CoverageMonthRow[]; syncRuns?: SyncRunRow[]; employees?: NotifyEmployee[] } = {},
): Promise<NotifyContext> {
  const w = factsWindow(now, opts.earliest);
  const [employees, facts, sourceHorizons, toolColors, coverage, syncRuns, fixedCosts] = await Promise.all([
    opts.employees ?? store.employees(),
    store.facts(w.from, w.toExclusive),
    store.sourceHorizons(),
    store.toolColors(),
    opts.coverage ?? store.importCoverage(now.toISOString().slice(0, 7)),
    opts.syncRuns ?? store.recentSyncRuns(syncRunsSince(now)),
    store.fixedCostSettings(),
  ]);
  return {
    now,
    baseUrl,
    employees,
    employeesById: new Map(employees.map((e) => [e.id, e])),
    tree: buildReportingTree(employees),
    facts,
    sourceHorizons,
    toolColors,
    freshness: sourceFreshness(syncRuns),
    coverage,
    syncRuns,
    fixedCosts,
  };
}

function sectionInput(ctx: NotifyContext, period: DigestPeriod, includeFixed: boolean): SectionInput {
  return {
    employeesById: ctx.employeesById,
    facts: ctx.facts,
    period,
    now: ctx.now,
    sourceHorizons: ctx.sourceHorizons,
    toolColors: ctx.toolColors,
    freshness: ctx.freshness,
    missingImports: period.cadence === "monthly" ? monthlyReadiness(ctx.coverage, period.key).missing : [],
    baseUrl: ctx.baseUrl,
    includeFixed,
  };
}

export function digestFor(ctx: NotifyContext, employeeId: string, period: DigestPeriod): Digest | null {
  const recipient = ctx.employeesById.get(employeeId);
  if (!recipient) return null;
  const { include } = fixedCostsFor(ctx.fixedCosts, recipient);
  return buildDigest({ ...sectionInput(ctx, period, include), recipient, reportIds: ctx.tree.reportsOf(employeeId) });
}

/** A whole Okta department's digest (preview/test only — never scheduled). Callers validate the department. */
export function teamDigestFor(ctx: NotifyContext, department: string, period: DigestPeriod): TeamDigest | null {
  return buildTeamDigest({ ...sectionInput(ctx, period, fixedCostsForTeam(ctx.fixedCosts, department).include), department });
}
