import { AwaitingData, PageHeader, Panel } from "@/components/ui";

export default function PeoplePage() {
  return (
    <>
      <PageHeader
        title="People"
        subtitle="Per-person seats, seat cost, overage, metered spend, and activity."
      />
      <Panel>
        <AwaitingData note="Searchable, sortable table. Sort by 'seat cost with zero activity' for the seat-hygiene view; click a person → profile panel (spec §7.3)" />
      </Panel>
    </>
  );
}
