import { AwaitingData, PageHeader, Panel } from "@/components/ui";

export default function DepartmentsPage() {
  return (
    <>
      <PageHeader
        title="Departments"
        subtitle="Dept × vendor matrix with totals and per-head spend."
      />
      <Panel>
        <AwaitingData note="Dept × vendor matrix; per-head = dept spend ÷ HiBob headcount. Click a dept → people + trend (spec §7.2)" />
      </Panel>
    </>
  );
}
