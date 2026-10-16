import { Panel } from "@/components/ui";
import { AccessList, type AccessPerson } from "@/components/access/access-list";
import { parseAdminEmails } from "@/lib/dashboard-access";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { fetchAccessList } from "@/lib/queries/dashboard-access";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isActiveEmployee, NOTIFY_EMPLOYEE_COLUMNS, toNotifyEmployee } from "@/lib/notify/types";

/** Admin-only (data/page.tsx): who besides the admins can open the dashboard. */
export async function AccessTab() {
  const supabase = getSupabaseAdminClient();
  const [list, employees] = await Promise.all([fetchAccessList(supabase), fetchEmployeesAll(supabase, NOTIFY_EMPLOYEE_COLUMNS)]);
  const byEmail = new Map(employees.map(toNotifyEmployee).map((e) => [e.email, e]));
  const admins = parseAdminEmails(process.env.ADMIN_EMAILS);
  const person = (email: string): AccessPerson => {
    const e = byEmail.get(email);
    return { email, name: e?.fullName ?? null, team: e?.department ?? null, left: !!e && !isActiveEmployee(e) };
  };
  const taken = new Set([...admins, ...list.map((r) => r.email)]);
  const options = [...byEmail.values()]
    .filter((e) => isActiveEmployee(e) && e.email && !taken.has(e.email))
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((e) => ({ email: e.email, label: `${e.fullName} — ${e.department ?? "No team"} (${e.email})` }));

  return (
    <div className="space-y-6">
      <Panel>
        <h2 className="mb-1 text-sm font-medium">Dashboard access</h2>
        <p className="mb-4 text-xs text-muted">
          Anyone else who signs in sees &ldquo;You don&apos;t have access&rdquo;. Viewers see the dashboard; admins also get every Data tab,
          including this one. Changes apply on their next page load. Slack digests show the Open in dashboard button and links only to
          people who can get in.
        </p>
        <AccessList
          rows={list.map((r) => ({ ...person(r.email), role: r.role, addedBy: r.addedBy, addedAt: r.addedAt }))}
          admins={admins.map(person)}
          options={options}
        />
      </Panel>
    </div>
  );
}
