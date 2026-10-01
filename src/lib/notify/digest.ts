import { dimColorFor, dimLabel, isMonthlyLevelFact, UNATTRIBUTED, type ShapeFact } from "@/lib/explore/shape";
import { vendorKeyOf } from "@/lib/explore/vendor-filter";
import { projectPeriodEnd } from "@/lib/explore/project";
import { caveatsFor, type MissingImport, type SourceFreshness } from "./freshness";
import type { DigestPeriod } from "./schedule";
import { isActiveEmployee, type NotifyEmployee } from "./types";

export type Basis = "usage" | "total";

export interface ToolAmount {
  key: string; // vendorKeyOf: a vendor, or "other:<tool>"
  label: string;
  color: string;
  usd: number;
}

export interface ChartBucket {
  label: string;
  current: boolean;
  byTool: Record<string, number>;
  totalUsd: number;
}

export interface MonthContext {
  monthLabel: string; // "September"
  soFarUsd: number; // all cost types
  projectedUsd: number | null; // current month only
  complete: boolean; // the month has ended → "September total $X"
}

export interface DigestSection {
  basis: Basis;
  headlineUsd: number;
  prevUsd: number;
  deltaPct: number | null; // null when the previous period was $0
  byTool: ToolAmount[]; // this period, desc
  chartTools: ToolAmount[]; // across the chart span, desc — stack order + colours
  chart: ChartBucket[];
  month: MonthContext | null; // daily/weekly only
}

export interface TopPerson {
  employeeId: string;
  name: string;
  usd: number;
  href: string;
}

export interface ReportsSection extends DigestSection {
  headcount: number; // ACTIVE descendants; leavers' spend still counts in the figures
  top: TopPerson[];
  othersCount: number;
  othersUsd: number;
}

export interface Digest {
  recipient: { employeeId: string; name: string; team: string | null };
  period: DigestPeriod;
  you: DigestSection;
  reports: ReportsSection | null; // present iff the recipient has descendants
  caveats: string[];
  dashboardUrl: string;
}

export interface DigestInput {
  recipient: NotifyEmployee;
  reportIds: string[];
  employeesById: ReadonlyMap<string, NotifyEmployee>;
  facts: ShapeFact[];
  period: DigestPeriod;
  now: Date;
  sourceHorizons: Record<string, string>;
  toolColors: Record<string, string>;
  freshness: SourceFreshness[];
  missingImports: MissingImport[];
  baseUrl: string;
}

const TOP_N = 5;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Cents, with -0 normalised (formatUsd(-0) would print "-$0.00"). */
const round2 = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
};
const inRange = (f: ShapeFact, from: string, to: string) => f.day >= from && f.day < to;
const total = (fs: ShapeFact[]) => fs.reduce((s, f) => s + f.costUsd, 0);

export function personHref(baseUrl: string, e: Pick<NotifyEmployee, "id" | "department">): string {
  return `${baseUrl}/explore/${encodeURIComponent(e.department ?? UNATTRIBUTED)}/${e.id}`;
}

function sumBy(facts: ShapeFact[], key: (f: ShapeFact) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of facts) m.set(key(f), (m.get(key(f)) ?? 0) + f.costUsd);
  return m;
}

function toolAmounts(totals: Map<string, number>, toolColors: Record<string, string>): ToolAmount[] {
  return [...totals]
    .map(([key, usd]) => ({ key, label: dimLabel("vendor", key), color: dimColorFor("vendor", key, toolColors), usd: round2(usd) }))
    .filter((t) => t.usd > 0)
    .sort((a, b) => b.usd - a.usd || a.label.localeCompare(b.label));
}

/** Daily/weekly count usage only; seats, subscriptions and monthly usage lumps would distort short periods. */
const basisOf = (p: DigestPeriod): Basis => (p.cadence === "monthly" ? "total" : "usage");
const counted = (facts: ShapeFact[], basis: Basis) => (basis === "usage" ? facts.filter((f) => !isMonthlyLevelFact(f)) : facts);

function monthContext(pop: ShapeFact[], { period, now, sourceHorizons }: DigestInput): MonthContext {
  const lastDay = new Date(Date.parse(`${period.toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const month = lastDay.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const toExclusive = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const complete = month !== now.toISOString().slice(0, 7);
  // projectPeriodEnd reads facts[0] — never call it on an empty population.
  const projection =
    complete || pop.length === 0
      ? null
      : projectPeriodEnd(pop, now, { granularity: "month", from, toExclusive, label: `${MONTHS[m - 1]} ${y}` }, sourceHorizons);
  return {
    monthLabel: MONTHS[m - 1],
    soFarUsd: round2(total(pop.filter((f) => inRange(f, from, toExclusive)))),
    projectedUsd: projection ? round2(projection.projectedUsd) : null,
    complete,
  };
}

function section(pop: ShapeFact[], input: DigestInput): DigestSection {
  const { period, toolColors } = input;
  const basis = basisOf(period);
  const base = counted(pop, basis);
  const cur = base.filter((f) => inRange(f, period.from, period.toExclusive));
  const headlineUsd = round2(total(cur));
  const prevUsd = round2(total(base.filter((f) => inRange(f, period.prev.from, period.prev.toExclusive))));
  const inSpan = base.filter((f) => inRange(f, period.buckets[0].from, period.toExclusive));
  const chart = period.buckets.map((b) => {
    const m = sumBy(inSpan.filter((f) => inRange(f, b.from, b.toExclusive)), vendorKeyOf);
    return {
      label: b.label,
      current: b.current,
      byTool: Object.fromEntries([...m].map(([k, v]) => [k, round2(v)])),
      totalUsd: round2([...m.values()].reduce((s, v) => s + v, 0)),
    };
  });
  return {
    basis,
    headlineUsd,
    prevUsd,
    deltaPct: prevUsd > 0 ? Math.round(((headlineUsd - prevUsd) / prevUsd) * 1000) / 10 : null,
    byTool: toolAmounts(sumBy(cur, vendorKeyOf), toolColors),
    chartTools: toolAmounts(sumBy(inSpan, vendorKeyOf), toolColors),
    chart,
    month: basis === "usage" ? monthContext(pop, input) : null,
  };
}

/**
 * One recipient's digest for one period, or null to skip (daily with no usage
 * anywhere in their tree). Person-less facts (department subscriptions,
 * unkeyed rows) have no employeeId, so they never enter either population.
 */
export function buildDigest(input: DigestInput): Digest | null {
  const { recipient, reportIds, employeesById, facts, period, baseUrl } = input;
  const reportSet = new Set(reportIds);
  const youFacts = facts.filter((f) => f.employeeId === recipient.id);
  const reportFacts = reportIds.length ? facts.filter((f) => f.employeeId !== null && reportSet.has(f.employeeId)) : [];

  const you = section(youFacts, input);
  let reports: ReportsSection | null = null;
  if (reportIds.length) {
    const base = section(reportFacts, input);
    const perPerson = sumBy(
      counted(reportFacts, base.basis).filter((f) => inRange(f, period.from, period.toExclusive)),
      (f) => f.employeeId as string,
    );
    const ranked = [...perPerson]
      .map(([id, usd]) => ({ id, usd: round2(usd), name: employeesById.get(id)?.fullName ?? "Unknown" }))
      .filter((p) => p.usd > 0)
      .sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name));
    const rest = ranked.slice(TOP_N);
    reports = {
      ...base,
      headcount: reportIds.filter((id) => {
        const e = employeesById.get(id);
        return e ? isActiveEmployee(e) : false;
      }).length,
      top: ranked.slice(0, TOP_N).map((p) => ({
        employeeId: p.id,
        name: p.name,
        usd: p.usd,
        href: personHref(baseUrl, employeesById.get(p.id) ?? { id: p.id, department: null }),
      })),
      othersCount: rest.length,
      // The remainder of the headline, not a sum of rounded amounts, so top + others equals it to the cent.
      othersUsd: round2(base.headlineUsd - ranked.slice(0, TOP_N).reduce((s, p) => s + p.usd, 0)),
    };
  }

  if (period.cadence === "daily" && you.headlineUsd === 0 && (reports?.headlineUsd ?? 0) === 0) return null;

  // Same basis as the headline: a seat stamped on the 1st doesn't make a weekly recipient a "user" of that source.
  const sourcesUsed = new Set<string>(
    counted([...youFacts, ...reportFacts], you.basis).filter((f) => inRange(f, period.buckets[0].from, period.toExclusive)).map((f) => f.source),
  );
  return {
    recipient: { employeeId: recipient.id, name: recipient.fullName, team: recipient.department },
    period,
    you,
    reports,
    caveats: caveatsFor({ period, sourcesUsed, freshness: input.freshness, missingImports: input.missingImports }),
    dashboardUrl: personHref(baseUrl, recipient),
  };
}
