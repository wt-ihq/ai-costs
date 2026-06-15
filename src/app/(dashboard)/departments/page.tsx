import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getDepartmentsData } from "@/lib/queries/departments";
import { PageHeader, Panel } from "@/components/ui";
import { VENDOR_LABEL } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { formatUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DepartmentsPage() {
  const { month, vendors, rows } = await getDepartmentsData(getSupabaseAdminClient(), new Date());

  return (
    <>
      <PageHeader title="Departments" subtitle={`Dept × vendor spend for ${month}, with per-head.`} />
      <Panel className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-3 font-medium">Department</th>
              {vendors.map((v) => (
                <th key={v} className="px-4 py-3 text-right font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: VENDOR_COLORS[v] }} />
                    {VENDOR_LABEL[v]}
                  </span>
                </th>
              ))}
              <th className="px-4 py-3 text-right font-medium">Total</th>
              <th className="px-4 py-3 text-right font-medium">Head</th>
              <th className="px-4 py-3 text-right font-medium">Per head</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.department} className="border-b border-border/60 last:border-0 hover:bg-surface-2/40">
                <td className="px-4 py-2.5 font-medium">{r.department}</td>
                {vendors.map((v) => (
                  <td key={v} className="px-4 py-2.5 text-right tabular-nums text-muted">
                    {r.perVendor[v] ? formatUsd(r.perVendor[v]!) : "—"}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right font-medium tabular-nums">{formatUsd(r.total)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted">{r.headcount || "—"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                  {r.perHead == null ? "—" : formatUsd(r.perHead)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
