import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { defaultSeatPrice } from "@/lib/ingest/seat-months";
import { pageAll, supabaseNotifyStore } from "@/lib/notify/store";
import { importsInUseSince, readinessSyncSince, recommendationsReadiness, type Readiness } from "@/lib/notify/readiness";
import {
  REC_TOOLS,
  latestSunday,
  recommend,
  weeksEnding,
  type RecCandidate,
  type RecSpend,
  type RecTier,
  type RecTool,
  type RecToolResult,
  type RecUsage,
  type RecWeek,
} from "./rule";

export interface RecommendationsData {
  sunday: string;
  weeks: RecWeek[];
  tools: RecToolResult[];
  readiness: Readiness; // recommendationsReadiness for the latest week
  rosterAsOf: Partial<Record<RecTool, string>>; // latest imports.kind='roster' data_as_of per vendor
  cursorRosterStale: boolean; // rosterAsOf.cursor missing or > ROSTER_STALE_DAYS before sunday
  departments: string[]; // of flagged rows, sorted
  updatedAt: string; // ISO, when loaded
}

export const ROSTER_STALE_DAYS = 35;

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Latest assignment at or before `month` per employee; unrecognised tier strings count as standard. */
export function latestTierByEmployee(
  rows: { employeeId: string; seatType: string; periodStart: string }[],
  month: string,
): Map<string, RecTier> {
  const best = new Map<string, { seatType: string; periodStart: string }>();
  for (const r of rows) {
    if (r.periodStart > month) continue;
    const cur = best.get(r.employeeId);
    if (!cur || r.periodStart > cur.periodStart) best.set(r.employeeId, r);
  }
  const KNOWN = new Set(["premium", "standard", "free", "unassigned"]);
  const out = new Map<string, RecTier>();
  for (const [id, r] of best) out.set(id, KNOWN.has(r.seatType) ? (r.seatType as RecTier) : "standard");
  return out;
}

export function isRosterStale(asOf: string | undefined, sunday: string): boolean {
  return !asOf || asOf < addDays(sunday, -ROSTER_STALE_DAYS);
}

export async function loadRecommendations(supabase: SupabaseClient, now: Date): Promise<RecommendationsData> {
  const sunday = latestSunday(now);
  const month = sunday.slice(0, 7) + "-01";
  const from = weeksEnding(addDays(sunday, -7), 4)[0].from; // 35 days ending sunday inclusive
  const toExclusive = addDays(sunday, 1);

  const store = supabaseNotifyStore(supabase);
  const [employeeRows, syncRuns, imports, rosterRows] = await Promise.all([
    fetchEmployeesAll(supabase, "id, full_name, department, leave_date"),
    store.recentSyncRuns(readinessSyncSince(now)),
    store.manualImports(importsInUseSince(sunday)),
    pageAll<{ source: string; data_as_of: string }>(
      (a, b) =>
        supabase
          .from("imports")
          .select("source, data_as_of")
          .eq("kind", "roster")
          .eq("status", "success")
          .in("source", [...REC_TOOLS])
          .order("data_as_of", { ascending: false })
          .order("id")
          .range(a, b),
      "rosterAsOf",
    ),
  ]);
  const employees = new Map(
    employeeRows.map((e) => [
      e.id as string,
      { name: (e.full_name as string | null) ?? (e.id as string), department: (e.department as string | null) ?? null, leaveDate: (e.leave_date as string | null) ?? null },
    ]),
  );

  const rosterAsOf: Partial<Record<RecTool, string>> = {};
  for (const r of rosterRows) {
    const tool = r.source as RecTool;
    if (!rosterAsOf[tool] || r.data_as_of > rosterAsOf[tool]!) rosterAsOf[tool] = r.data_as_of;
  }

  const tools: RecToolResult[] = [];
  for (const tool of REC_TOOLS) {
    const [premium, standard] = await Promise.all([
      defaultSeatPrice(supabase, tool, "premium", month),
      defaultSeatPrice(supabase, tool, "standard", month),
    ]);

    const assignments = await pageAll<{ employee_id: string; seat_type: string; period_start: string }>(
      (a, b) =>
        supabase
          .from("seat_assignments")
          .select("employee_id, seat_type, period_start")
          .eq("vendor", tool)
          .order("employee_id")
          .order("period_start")
          .order("seat_type")
          .range(a, b),
      `seat_assignments ${tool}`,
    );
    const tiers = latestTierByEmployee(
      assignments.map((r) => ({ employeeId: r.employee_id, seatType: r.seat_type, periodStart: r.period_start })),
      month,
    );

    const factRows = await pageAll<{ day: string; employee_id: string; cost_usd: number | string }>(
      (a, b) =>
        supabase
          .from("spend_facts")
          .select("day, employee_id, cost_usd")
          .eq("source", tool)
          .eq("cost_type", "overage")
          .not("employee_id", "is", null)
          .gte("day", from)
          .lt("day", toExclusive)
          .order("day")
          .order("id")
          .range(a, b),
      `spend_facts ${tool}`,
    );
    const spend: RecSpend[] = factRows.map((r) => ({ employeeId: r.employee_id, day: r.day, costUsd: Number(r.cost_usd) }));

    let usage: RecUsage[] | undefined;
    if (tool === "cursor") {
      const usageRows = await pageAll<{ day: string; employee_id: string; agent_requests: number | string | null; is_active: boolean | null }>(
        (a, b) =>
          supabase
            .from("cursor_daily_usage")
            .select("day, employee_id, agent_requests, is_active")
            .not("employee_id", "is", null)
            .gte("day", from)
            .lt("day", toExclusive)
            .order("day")
            .order("id")
            .range(a, b),
        "cursor_daily_usage",
      );
      usage = usageRows.map((r) => ({ employeeId: r.employee_id, day: r.day, agentRequests: Number(r.agent_requests ?? 0), isActive: !!r.is_active }));
    }

    // Roster members plus every spender not on it (tier unknown), all joined to employees,
    // so the rule can drop leavers and name people it sees.
    const ids = new Set<string>([...tiers.keys(), ...spend.map((s) => s.employeeId)]);
    const candidates: RecCandidate[] = [];
    for (const id of ids) {
      const e = employees.get(id);
      candidates.push({
        employeeId: id,
        name: e?.name ?? id,
        department: e?.department ?? null,
        tier: tiers.get(id) ?? "unknown",
        leaveDate: e?.leaveDate ?? null,
      });
    }

    tools.push(recommend({ tool, stepUpUsd: premium - standard, candidates, spend, usage }, sunday));
  }

  const departments = [...new Set(tools.flatMap((t) => t.rows.map((r) => r.department)).filter((d): d is string => !!d))].sort();

  return {
    sunday,
    weeks: weeksEnding(sunday, 4),
    tools,
    readiness: recommendationsReadiness({ week: weeksEnding(sunday, 1)[0], syncRuns, imports }),
    rosterAsOf,
    cursorRosterStale: isRosterStale(rosterAsOf.cursor, sunday),
    departments,
    updatedAt: now.toISOString(),
  };
}
