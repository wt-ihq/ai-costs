import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getDataHealth } from "@/lib/queries/data-health";
import { PageHeader, Panel } from "@/components/ui";
import { UnmatchedQueue } from "@/components/unmatched-queue";
import { VENDOR_LABEL } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { staleness } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DataHealthPage() {
  const { identity, sources, unmatched, employees } = await getDataHealth(getSupabaseAdminClient());
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Data Health"
        subtitle="Identity spine and per-source freshness and last status, plus the unmatched-identity queue."
      />

      <Panel className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 text-right font-medium">Facts</th>
              <th className="px-4 py-3 font-medium">Latest data</th>
              <th className="px-4 py-3 font-medium">Last sync</th>
              <th className="px-4 py-3 font-medium">Manual import</th>
            </tr>
          </thead>
          <tbody>
            {/* Identity spine (Okta) — its "facts" count is employees synced. */}
            <tr className="border-b border-border/60 bg-surface-2/20">
              <td className="px-4 py-2.5">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <span className="size-2 rounded-full" style={{ background: "#6366f1" }} />
                  {identity.label}
                  <span className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">identity</span>
                </span>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                {identity.employeeCount || "—"}
                {identity.employeeCount ? <span className="ml-1 text-xs text-muted">people</span> : null}
              </td>
              <td className="px-4 py-2.5 text-muted">—</td>
              <td className="px-4 py-2.5 text-muted">
                {identity.lastSyncAt ? (
                  <span className={identity.lastSyncStatus === "failed" ? "text-pink-300" : ""}>
                    {staleness(new Date(identity.lastSyncAt), now)} · {identity.lastSyncStatus}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-4 py-2.5 text-muted">—</td>
            </tr>
            {sources.map((s) => (
              <tr key={s.source} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <span className="size-2 rounded-full" style={{ background: VENDOR_COLORS[s.source] }} />
                    {VENDOR_LABEL[s.source]}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted">{s.factCount || "—"}</td>
                <td className="px-4 py-2.5 text-muted">{s.latestDay ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted">
                  {s.lastSyncAt ? (
                    <span className={s.lastSyncStatus === "failed" ? "text-pink-300" : ""}>
                      {staleness(new Date(s.lastSyncAt), now)} · {s.lastSyncStatus}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {s.lastImportAsOf ? `${staleness(new Date(s.lastImportAsOf), now)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel className="mt-4">
        <h2 className="mb-1 text-sm font-medium">Unmatched identities</h2>
        <p className="mb-4 text-xs text-muted">
          Spend that didn&rsquo;t resolve to an employee. Assigning records an identity so future imports match automatically.
        </p>
        <UnmatchedQueue rows={unmatched} employees={employees} />
      </Panel>
    </>
  );
}
