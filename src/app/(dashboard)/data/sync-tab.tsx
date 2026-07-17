import { Panel } from "@/components/ui";
import { SyncControls } from "@/components/sync-controls";

/** On-demand sync trigger + backfill window controls (admin). */
export function SyncTab() {
  return (
    <Panel>
      <h2 className="mb-1 text-sm font-medium">Automated sync &amp; backfill</h2>
      <p className="mb-4 text-xs text-muted">
        On-demand trigger for the daily cron pipeline. Sources without API keys report an error and are skipped (the rest still run).
      </p>
      <SyncControls />
    </Panel>
  );
}
