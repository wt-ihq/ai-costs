import { notFound } from "next/navigation";
import { PageHeader, Panel } from "@/components/ui";
import { ChatGptImport } from "@/components/chatgpt-import";
import { ClaudeSpendImport } from "@/components/claude-spend-import";
import { ClaudeRosterImport } from "@/components/claude-roster-import";
import { SyncControls } from "@/components/sync-controls";
import { getRole } from "@/lib/auth-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildImportCoverage, getImportCoverageScope } from "@/lib/queries/import-coverage";
import { ImportCoverage } from "@/components/import-coverage";

export default async function ImportsPage() {
  // The nav only hides the link for viewers; the page itself must enforce it.
  if ((await getRole()) !== "admin") notFound();
  const { facts, imports } = await getImportCoverageScope(getSupabaseAdminClient());
  const coverage = buildImportCoverage(facts, imports, new Date().toISOString().slice(0, 7));
  return (
    <>
      <PageHeader
        title="Imports"
        subtitle="Monthly manual workflow, manual sync trigger, and backfill controls (admin)."
      />
      <div className="grid gap-4">
        <Panel>
          <h2 className="mb-1 text-sm font-medium">Import coverage</h2>
          <p className="mb-4 text-xs text-muted">
            Months with manually imported data, by source — a &ldquo;—&rdquo; is a gap (or a month that predates the tool).
          </p>
          <ImportCoverage rows={coverage} />
        </Panel>

        <Panel>
          <h2 className="mb-1 text-sm font-medium">Claude Team — roster (seats)</h2>
          <p className="mb-4 text-xs text-muted">
            Upload the roster CSV (Name, Email, Role, Status, Seat Tier). Email-matched; priced per tier.
          </p>
          <ClaudeRosterImport />
        </Panel>

        <Panel>
          <h2 className="mb-1 text-sm font-medium">Claude Team — MTD spend</h2>
          <p className="mb-4 text-xs text-muted">
            Paste the &ldquo;MTD spend&rdquo; table. Email-matched; £ converted to USD at the rate below.
          </p>
          <ClaudeSpendImport />
        </Panel>

        <Panel>
          <h2 className="mb-1 text-sm font-medium">ChatGPT Business — workspace analytics</h2>
          <p className="mb-4 text-xs text-muted">
            Paste the analytics table. Each listed member is a $25 seat; credits become overage. Fuzzy name-matched (no email).{" "}
            <span className="text-foreground">
              Export a <strong>Custom</strong> range covering exactly one calendar month — the 1M preset is a rolling
              30-day window and double-counts across months.
            </span>
          </p>
          <ChatGptImport />
        </Panel>

        <Panel>
          <h2 className="mb-1 text-sm font-medium">Automated sync &amp; backfill</h2>
          <p className="mb-4 text-xs text-muted">
            On-demand trigger for the daily cron pipeline. Sources without API keys report an error and are skipped (the rest still run).
          </p>
          <SyncControls />
        </Panel>
      </div>
    </>
  );
}
