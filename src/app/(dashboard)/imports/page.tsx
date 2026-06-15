import { AwaitingData, PageHeader, Panel } from "@/components/ui";

export default function ImportsPage() {
  return (
    <>
      <PageHeader
        title="Imports"
        subtitle="Monthly manual workflow, manual sync trigger, and backfill controls (admin)."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="mb-4 text-sm font-medium">Claude Team CSV</h2>
          <AwaitingData note="Drag-and-drop → parse → per-row validation → preview → confirm. Atomic (spec §6)" />
        </Panel>
        <Panel>
          <h2 className="mb-4 text-sm font-medium">ChatGPT Business</h2>
          <AwaitingData note="Paste member table (parses credits column) or hand-keyed fallback; stamps 'data as of'" />
        </Panel>
        <Panel className="lg:col-span-2">
          <h2 className="mb-4 text-sm font-medium">Sync & backfill</h2>
          <AwaitingData note="Manual sync trigger + backfill controls (spec §4, §7.6)" />
        </Panel>
      </div>
    </>
  );
}
