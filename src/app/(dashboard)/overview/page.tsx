import { AwaitingData, PageHeader, Panel, Scorecard } from "@/components/ui";

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Total monthly spend with seat / overage / metered split."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Scorecard label="Total monthly spend" value="—" delta="MoM —" />
        <Scorecard label="Seat" value="—" />
        <Scorecard label="Overage" value="—" />
        <Scorecard label="Metered" value="—" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <h2 className="mb-4 text-sm font-medium">12-month spend by vendor</h2>
          <AwaitingData note="Stacked area — wire to spend_facts rollup (spec §7.1)" />
        </Panel>
        <Panel>
          <h2 className="mb-4 text-sm font-medium">Spend by vendor</h2>
          <AwaitingData note="Vendor donut" />
        </Panel>
        <Panel className="lg:col-span-3">
          <h2 className="mb-4 text-sm font-medium">Spend by department</h2>
          <AwaitingData note="Department bar chart" />
        </Panel>
      </div>
    </>
  );
}
