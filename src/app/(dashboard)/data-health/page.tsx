import { AwaitingData, PageHeader, Panel } from "@/components/ui";

export default function DataHealthPage() {
  return (
    <>
      <PageHeader
        title="Data Health"
        subtitle="Per-source freshness, last sync status, and the unmatched-identity queue."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="mb-4 text-sm font-medium">Source freshness</h2>
          <AwaitingData note="Per-source last sync, row counts, manual-import age (spec §7.5)" />
        </Panel>
        <Panel>
          <h2 className="mb-4 text-sm font-medium">Unmatched identities</h2>
          <AwaitingData note="Queue with one-click 'assign to employee' (admin)" />
        </Panel>
      </div>
    </>
  );
}
