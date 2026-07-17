import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { pseudoExplanation } from "@/lib/queries/data-health";
import { getDataHealthCached } from "@/lib/queries/cached";
import { getCursorReconciliation } from "@/lib/queries/cursor-reconciliation";
import { PageHeader, Panel } from "@/components/ui";
import { UnmatchedQueue } from "@/components/unmatched-queue";
import { VENDOR_LABEL } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { staleness, formatUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DataHealthPage() {
  const supabase = getSupabaseAdminClient();
  const [{ identity, sources, unmatched, pseudo, employees, noDepartment }, reconciliation] = await Promise.all([
    getDataHealthCached(),
    getCursorReconciliation(supabase),
  ]);
  const now = new Date();
  // Flag a drift > $1 and > 2% as worth a look; otherwise it reconciles.
  const reconOff =
    reconciliation != null && Math.abs(reconciliation.deltaUsd) > 1 && Math.abs(reconciliation.deltaPct ?? 0) > 2;

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
              <th className="px-4 py-3 text-right font-medium" title="Spend records ingested for this source (employees, for the Okta identity row)">Records</th>
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
                {/* Real 0 must render as 0 — this page exists to spot empty sources. */}
                {identity.employeeCount}
                <span className="ml-1 text-xs text-muted">{identity.employeeCount === 1 ? "person" : "people"}</span>
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
                <td className="px-4 py-2.5 text-right tabular-nums text-muted">{s.factCount}</td>
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

      {reconciliation && (
        <Panel className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">
              Cursor spend reconciliation
              <span className="ml-2 text-xs font-normal text-muted">billing cycle since {reconciliation.cycleStart}</span>
            </h2>
            <span
              className={
                reconOff
                  ? "rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300"
                  : "rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300"
              }
            >
              {reconOff ? "drift — investigate" : "reconciles"}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted">
            Cursor reports <span className="tabular-nums text-foreground">{formatUsd(reconciliation.cursorSpendUsd)}</span>
            {" · "}we derived <span className="tabular-nums text-foreground">{formatUsd(reconciliation.ourOverageUsd)}</span>
            {" · "}Δ{" "}
            <span className={`tabular-nums ${reconOff ? "text-amber-300" : "text-foreground"}`}>
              {formatUsd(reconciliation.deltaUsd)}
              {reconciliation.deltaPct != null ? ` (${reconciliation.deltaPct.toFixed(1)}%)` : ""}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted">
            Our overage is summed from per-event <code>chargedCents</code>; Cursor&rsquo;s total is the authoritative
            <code> /teams/spend</code>. A persistent gap means events are being missed or double-counted.
          </p>
        </Panel>
      )}

      <Panel className="mt-4">
        <h2 className="mb-1 text-sm font-medium">Unmatched identities</h2>
        <p className="mb-4 text-xs text-muted">
          Spend that didn&rsquo;t resolve to an employee. Assigning records an identity so future imports match automatically.
        </p>
        <UnmatchedQueue rows={unmatched} employees={employees} />
      </Panel>

      {pseudo.length > 0 && (
        <Panel className="mt-4">
          <h2 className="mb-1 text-sm font-medium">Not person-attributable</h2>
          <p className="mb-4 text-xs text-muted">
            Real spend that by design belongs to no individual — shown for transparency, never assignable.
            On Explore, seat spend here appears under &ldquo;Shared seats&rdquo;.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 font-medium">Entity</th>
                <th className="py-2 pr-4 font-medium">What it is</th>
                <th className="py-2 text-right font-medium">Spend</th>
              </tr>
            </thead>
            <tbody>
              {pseudo.map((p) => (
                <tr key={`${p.source}:${p.entityKey}`} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-4">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: VENDOR_COLORS[p.source] }} />
                      {VENDOR_LABEL[p.source]}
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{p.entityKey}</td>
                  <td className="py-2 pr-4 text-xs text-muted">{pseudoExplanation(p.entityKey)}</td>
                  <td className="py-2 text-right tabular-nums">{formatUsd(p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {noDepartment.length > 0 && (
        <Panel className="mt-4">
          <h2 className="mb-1 text-sm font-medium">People without a department ({noDepartment.length})</h2>
          <p className="mb-4 text-xs text-muted">
            Their spend lands in Explore&rsquo;s &ldquo;Unattributed&rdquo; row. Current staff here are fixable —
            set the department on their Okta profile; leavers keep their historical spend unplaceable.
          </p>
          <div className="flex flex-wrap gap-2">
            {noDepartment.map((p) => (
              <span
                key={p.id}
                className={`rounded-md border border-border bg-surface-2 px-2 py-1 text-xs ${p.left ? "text-muted" : "text-foreground"}`}
              >
                {p.name}
                {p.left && <span className="ml-1 text-[10px] uppercase tracking-wide text-muted">left</span>}
              </span>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}
