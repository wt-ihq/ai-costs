import { Panel } from "@/components/ui";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { RecurringCosts, type RecurringCostRow } from "@/components/recurring-costs";
import { VercelProjects, type VercelProjectRow } from "@/components/vercel-projects";
import { OpenRouterWorkspaces, type OpenRouterWorkspaceRow } from "@/components/openrouter-workspaces";
import { fetchRecurringEntries, monthsBetween } from "@/lib/ingest/recurring";
import { OTHER_TOOL_PALETTE } from "@/lib/colors";
import { fetchEmployeesAll } from "@/lib/queries/common";

/** Department-attributed tool costs (admin): recurring subscriptions + Vercel project mapping. */
export async function ToolsTab() {
  const supabase = getSupabaseAdminClient();
  const [recurringRaw, emps, { data: vercelRows }, { data: workspaceRows }] = await Promise.all([
    fetchRecurringEntries(supabase),
    fetchEmployeesAll(supabase, "department"),
    supabase
      .from("vercel_projects")
      .select("project_id, project_name, department")
      .order("project_name")
      .limit(200), // bounded: grows by projects, not rows-per-day
    supabase
      .from("openrouter_workspaces")
      .select("workspace_id, name, department")
      .order("name")
      .limit(200), // bounded: grows by workspaces
  ]);
  const recurringRows: RecurringCostRow[] = recurringRaw.map((e) => {
    const months = e.kind === "contract" ? monthsBetween(e.startMonth, e.endMonth!).length : 1;
    const usd = Math.round(e.amount * e.fxRate * 100) / 100;
    return {
      id: e.id, tool: e.tool, vendor: e.vendor, color: OTHER_TOOL_PALETTE[e.colorSlot % OTHER_TOOL_PALETTE.length],
      department: e.department, kind: e.kind, amount: e.amount, currency: e.currency, fxRate: e.fxRate,
      startMonth: e.startMonth.slice(0, 7), endMonth: e.endMonth?.slice(0, 7) ?? null,
      monthlyUsd: e.kind === "contract" ? Math.round((usd / months) * 100) / 100 : usd,
    };
  });
  const departments = [...new Set(emps.map((e) => e.department as string | null).filter(Boolean))].sort() as string[];
  const vercelProjects: VercelProjectRow[] = (vercelRows ?? []).map((r) => ({
    projectId: r.project_id as string,
    projectName: r.project_name as string,
    department: (r.department as string) ?? null,
  }));
  const openRouterWorkspaces: OpenRouterWorkspaceRow[] = (workspaceRows ?? []).map((r) => ({
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    department: (r.department as string) ?? null,
  }));

  return (
    <div className="grid gap-4">
      <Panel>
        <h2 className="mb-1 text-sm font-medium">Other AI tools — recurring costs</h2>
        <p className="mb-4 text-xs text-muted">
          Tools the dashboard doesn&rsquo;t track automatically. Monthly prices repeat until ended; up-front
          contracts spread evenly across their months. Costs land on the chosen department and each tool
          appears as its own vendor in Explore. Price change? End the entry and add a new one.
        </p>
        <RecurringCosts entries={recurringRows} departments={departments} />
      </Panel>

      <Panel>
        <h2 className="mb-1 text-sm font-medium">OpenRouter workspaces</h2>
        <p className="mb-4 text-xs text-muted">
          Usage from workspace-owned API keys (no member attached) attributes to the workspace&rsquo;s
          department. New workspaces default to their own name — correct any that don&rsquo;t match an
          actual department. Member usage always follows the member&rsquo;s own department.
        </p>
        <OpenRouterWorkspaces workspaces={openRouterWorkspaces} departments={departments} />
      </Panel>

      <Panel>
        <h2 className="mb-1 text-sm font-medium">Vercel projects</h2>
        <p className="mb-4 text-xs text-muted">
          Vercel spend syncs nightly per project. Assign each project to a department to place its cost on
          that team&rsquo;s row — unassigned projects (and team-level charges like the plan fee) show under
          Unattributed. Projects appear here automatically after each sync.
        </p>
        <VercelProjects projects={vercelProjects} departments={departments} />
      </Panel>
    </div>
  );
}
