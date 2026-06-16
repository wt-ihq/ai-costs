import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOverviewData } from "@/lib/queries/overview";
import { PageHeader, Panel, Scorecard } from "@/components/ui";
import { DepartmentBars, TrendChart, VendorDonut } from "@/components/overview-charts";
import { VENDOR_LABEL, type Vendor } from "@/lib/types";
import { VENDOR_COLORS } from "@/lib/colors";
import { formatUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

function deltaLabel(current: number, prev: number): string {
  if (prev === 0) return "no prior month";
  const pct = ((current - prev) / prev) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% MoM`;
}

export default async function OverviewPage() {
  const data = await getOverviewData(getSupabaseAdminClient(), new Date());
  const vendors = data.bySource.map((s) => s.source);

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`Total spend for ${data.currentMonth}, with seat / overage / metered split.`}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Scorecard
          label="Total this month"
          value={formatUsd(data.currentTotal)}
          delta={deltaLabel(data.currentTotal, data.prevTotal)}
        />
        <Scorecard label="Seat" value={formatUsd(data.costSplit.seat)} />
        <Scorecard label="Overage" value={formatUsd(data.costSplit.overage)} />
        <Scorecard label="Metered" value={formatUsd(data.costSplit.metered)} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <h2 className="mb-4 text-sm font-medium">12-month spend by vendor</h2>
          <TrendChart data={data.trend} vendors={vendors} />
        </Panel>

        <Panel>
          <h2 className="mb-4 text-sm font-medium">This month by vendor</h2>
          <VendorDonut data={data.bySource} />
          <ul className="mt-4 space-y-1.5 text-sm">
            {data.bySource.map((s) => (
              <li key={s.source} className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-muted">
                  <span className="size-2.5 rounded-full" style={{ background: VENDOR_COLORS[s.source as Vendor] }} />
                  {VENDOR_LABEL[s.source]}
                </span>
                <span className="tabular-nums">{formatUsd(s.total)}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="lg:col-span-3">
          <h2 className="mb-4 text-sm font-medium">This month by department</h2>
          <DepartmentBars data={data.byDepartment} />
        </Panel>
      </div>
    </>
  );
}
