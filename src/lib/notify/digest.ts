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
  soFarUsd: number; // on the section's basis (fixed costs counted in full when included)
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
  /** The headline minus the top people, exact to the cent: the other people AND any team-level spend. */
  othersUsd: number;
  /**
   * Team digests only: spend on the headline basis that belongs to no current member (person-less
   * department costs, or a department-tagged fact of someone in another department). Part of
   * `othersUsd`; the renderer shows it separately so "others" is only people.
   */
  teamLevelUsd?: number;
}

export interface Digest {
  recipient: { employeeId: string; name: string; team: string | null };
  period: DigestPeriod;
  you: DigestSection;
  reports: ReportsSection | null; // present iff the recipient has descendants
  caveats: string[];
  dashboardUrl: string;
}

/**
 * One whole team (an Okta department) for one period. Preview/test only: subscriptions stay per
 * person, so nothing schedules this. The team reuses ReportsSection — it ranks people the same way.
 */
export interface TeamDigest {
  kind: "team";
  department: string;
  period: DigestPeriod;
  team: ReportsSection;
  caveats: string[];
  dashboardUrl: string;
}

/** Person digests carry no `kind`; team digests are `kind: "team"`. */
export function isTeamDigest(d: Digest | TeamDigest): d is TeamDigest {
  return "kind" in d && d.kind === "team";
}

/** What every digest kind needs to turn a fact population into a section. */
export interface SectionInput {
  employeesById: ReadonlyMap<string, NotifyEmployee>;
  facts: ShapeFact[];
  period: DigestPeriod;
  now: Date;
  sourceHorizons: Record<string, string>;
  toolColors: Record<string, string>;
  freshness: SourceFreshness[];
  missingImports: MissingImport[];
  baseUrl: string;
  /** Count seats & subscriptions (fixed-costs.ts resolves it for the recipient or team). */
  includeFixed: boolean;
}

export interface DigestInput extends SectionInput {
  recipient: NotifyEmployee;
  reportIds: string[];
}

export interface TeamDigestInput extends SectionInput {
  department: string;
}

const TOP_N = 5;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Cents, with -0 normalised (formatUsd(-0) would print "-$0.00"). */
export const round2 = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
};
const inRange = (f: ShapeFact, from: string, to: string) => f.day >= from && f.day < to;
const total = (fs: ShapeFact[]) => fs.reduce((s, f) => s + f.costUsd, 0);

export function teamHref(baseUrl: string, department: string): string {
  return `${baseUrl}/explore/${encodeURIComponent(department)}`;
}

export function personHref(baseUrl: string, e: Pick<NotifyEmployee, "id" | "department">): string {
  return `${teamHref(baseUrl, e.department ?? UNATTRIBUTED)}/${e.id}`;
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

const isFixed = (f: ShapeFact) => f.costType === "seat" || f.costType === "subscription";
const basisOf = (input: Pick<SectionInput, "includeFixed">): Basis => (input.includeFixed ? "total" : "usage");

/** A fixed cost as equal daily shares of its month — Explore's day-view rule — so a daily or weekly gets its share. */
function spreadOverMonth(f: ShapeFact): ShapeFact[] {
  const month = f.day.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => ({ ...f, day: `${month}-${String(i + 1).padStart(2, "0")}`, costUsd: f.costUsd / days }));
}

/**
 * The facts a section counts:
 *  - seats & subscriptions only when included — as posted for a monthly, spread by day for a daily/weekly;
 *  - Claude Team's monthly usage lump only in a monthly (it can't be split by day);
 *  - everything else always.
 * Only months touching the chart span are spread: nothing outside it is ever read.
 */
function counted(facts: ShapeFact[], { period, includeFixed }: Pick<SectionInput, "period" | "includeFixed">): ShapeFact[] {
  const monthly = period.cadence === "monthly";
  const spanFrom = period.buckets[0].from.slice(0, 7);
  const spanTo = period.toExclusive;
  return facts.flatMap((f) => {
    if (isFixed(f)) {
      if (!includeFixed) return [];
      if (monthly) return [f];
      const month = f.day.slice(0, 7);
      return month < spanFrom || `${month}-01` >= spanTo ? [] : spreadOverMonth(f);
    }
    if (isMonthlyLevelFact(f)) return monthly ? [f] : [];
    return [f];
  });
}

function monthContext(all: ShapeFact[], { period, now, sourceHorizons, includeFixed }: SectionInput): MonthContext {
  // The month as posted (a seat in full on the 1st), on the section's basis.
  const pop = includeFixed ? all : all.filter((f) => !isFixed(f));
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

function section(pop: ShapeFact[], input: SectionInput): DigestSection {
  const { period, toolColors } = input;
  const basis = basisOf(input);
  const base = counted(pop, input);
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
    month: period.cadence === "monthly" ? null : monthContext(pop, input),
  };
}

/**
 * A section for a group of people: the group's figures plus its ranked people. `memberIds` are the
 * people the group is made of (leavers included — their spend counts, they just aren't headcount);
 * `pop` may also hold facts of no member (a team's department-attributed costs), which count in the
 * headline but belong to no one, so they end up in the remainder (and are never ranked or named).
 */
function peopleSection(pop: ShapeFact[], memberIds: readonly string[], input: SectionInput): ReportsSection {
  const { period, employeesById, baseUrl } = input;
  const members = new Set(memberIds);
  const base = section(pop, input);
  // Only current members are ranked and named; anything else in `pop` is team-level spend.
  const perPerson = sumBy(
    counted(pop, input).filter((f) => f.employeeId !== null && members.has(f.employeeId) && inRange(f, period.from, period.toExclusive)),
    (f) => f.employeeId as string,
  );
  const ranked = [...perPerson]
    .map(([id, usd]) => ({ id, usd: round2(usd), name: employeesById.get(id)?.fullName ?? "Unknown" }))
    .filter((p) => p.usd > 0)
    .sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name));
  const top = ranked.slice(0, TOP_N);
  return {
    ...base,
    headcount: memberIds.filter((id) => {
      const e = employeesById.get(id);
      return e ? isActiveEmployee(e) : false;
    }).length,
    top: top.map((p) => ({
      employeeId: p.id,
      name: p.name,
      usd: p.usd,
      href: personHref(baseUrl, employeesById.get(p.id) ?? { id: p.id, department: null }),
    })),
    othersCount: ranked.length - top.length,
    // The remainder of the headline, not a sum of rounded amounts, so top + others equals it to the cent.
    othersUsd: round2(base.headlineUsd - top.reduce((s, p) => s + p.usd, 0)),
  };
}

/** Same basis as the headline: a seat the digest doesn't count doesn't make the recipient a "user" of that source. */
function caveatsOf(pop: ShapeFact[], input: SectionInput): string[] {
  const { period, freshness, missingImports } = input;
  const sourcesUsed = new Set<string>(counted(pop, input).filter((f) => inRange(f, period.buckets[0].from, period.toExclusive)).map((f) => f.source));
  return caveatsFor({ period, sourcesUsed, freshness, missingImports });
}

/**
 * One recipient's digest for one period, or null to skip (daily with no usage
 * anywhere in their tree). Person-less facts (department subscriptions,
 * unkeyed rows) have no employeeId, so they never enter either population.
 */
export function buildDigest(input: DigestInput): Digest | null {
  const { recipient, reportIds, facts, period, baseUrl } = input;
  const reportSet = new Set(reportIds);
  const youFacts = facts.filter((f) => f.employeeId === recipient.id);
  const reportFacts = reportIds.length ? facts.filter((f) => f.employeeId !== null && reportSet.has(f.employeeId)) : [];

  const you = section(youFacts, input);
  const reports = reportIds.length ? peopleSection(reportFacts, reportIds, input) : null;

  if (period.cadence === "daily" && you.headlineUsd === 0 && (reports?.headlineUsd ?? 0) === 0) return null;

  return {
    recipient: { employeeId: recipient.id, name: recipient.fullName, team: recipient.department },
    period,
    you,
    reports,
    caveats: caveatsOf([...youFacts, ...reportFacts], input),
    dashboardUrl: personHref(baseUrl, recipient),
  };
}

/**
 * A whole team's digest, or null (daily with no usage). Population = Explore's team rule, so a
 * monthly total matches the Explore team page: facts of any employee currently in the Okta
 * department (active or leaver) OR facts tagged with the department (`ShapeFact.department`:
 * the fact's own, else the person's) — person-less recurring costs, or a person from elsewhere
 * whose fact carries this department. Only members are ranked; the rest is `teamLevelUsd`.
 */
export function buildTeamDigest(input: TeamDigestInput): TeamDigest | null {
  const { department, employeesById, facts, period, baseUrl } = input;
  const memberIds = [...employeesById.values()].filter((e) => e.department === department).map((e) => e.id);
  const members = new Set(memberIds);
  const isMember = (f: ShapeFact) => f.employeeId !== null && members.has(f.employeeId);
  const pop = facts.filter((f) => isMember(f) || f.department === department);

  const ranked = peopleSection(pop, memberIds, input);
  const teamLevelUsd = round2(total(counted(pop, input).filter((f) => !isMember(f) && inRange(f, period.from, period.toExclusive))));
  const team: ReportsSection = { ...ranked, teamLevelUsd };
  if (period.cadence === "daily" && team.headlineUsd === 0) return null;

  return {
    kind: "team",
    department,
    period,
    team,
    caveats: caveatsOf(pop, input),
    dashboardUrl: teamHref(baseUrl, department),
  };
}
