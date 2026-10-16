import { Panel } from "@/components/ui";
import { SyncControls } from "@/components/sync-controls";
import { CursorRebuild } from "@/components/cursor-rebuild";

/** On-demand sync trigger + backfill window controls, and the Cursor history rebuild (admin). */
export function SyncTab() {
  return (
    <div className="grid gap-4">
      <Panel>
        <h2 className="mb-1 text-sm font-medium">Automated sync &amp; backfill</h2>
        <p className="mb-4 text-xs text-muted">
          On-demand trigger for the daily cron pipeline. Sources without API keys report an error and are skipped (the rest still run).
        </p>
        <SyncControls />
      </Panel>
      <Panel>
        <h2 className="mb-1 text-sm font-medium">Rebuild Cursor on-demand spend</h2>
        <p className="mb-4 text-xs text-muted">
          Re-imports one month of Cursor usage-based charges from Cursor&rsquo;s API and replaces that month&rsquo;s Cursor usage figures (seats are untouched).
          Use it to correct history after a change to how Cursor spend is counted. A busy month can take a few minutes.
        </p>
        <CursorRebuild />
      </Panel>
    </div>
  );
}
