import { AwaitingData, PageHeader, Panel } from "@/components/ui";
import { ChatGptImport } from "@/components/chatgpt-import";
import { ClaudeSpendImport } from "@/components/claude-spend-import";
import { ClaudeRosterImport } from "@/components/claude-roster-import";

export default function ImportsPage() {
  return (
    <>
      <PageHeader
        title="Imports"
        subtitle="Monthly manual workflow, manual sync trigger, and backfill controls (admin)."
      />
      <div className="grid gap-4">
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
            Paste the analytics table. Each listed member is a $25 seat; credits become overage. Fuzzy name-matched (no email).
          </p>
          <ChatGptImport />
        </Panel>

        <Panel>
          <h2 className="mb-4 text-sm font-medium">Automated sync &amp; backfill</h2>
          <AwaitingData note="Manual sync trigger + historical backfill controls for the API sources (spec §4, §7.6)" />
        </Panel>
      </div>
    </>
  );
}
