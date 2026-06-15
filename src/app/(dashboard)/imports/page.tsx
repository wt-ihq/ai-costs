import { AwaitingData, PageHeader, Panel } from "@/components/ui";
import { ChatGptImport } from "@/components/chatgpt-import";
import { ClaudeSpendImport } from "@/components/claude-spend-import";

export default function ImportsPage() {
  return (
    <>
      <PageHeader
        title="Imports"
        subtitle="Monthly manual workflow, manual sync trigger, and backfill controls (admin)."
      />
      <div className="grid gap-4">
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
            Paste the analytics table. Fuzzy name-matched (no email); credits converted via rate.
          </p>
          <ChatGptImport />
        </Panel>

        <Panel>
          <h2 className="mb-4 text-sm font-medium">Claude Team roster (seats) &amp; sync</h2>
          <AwaitingData note="Roster CSV upload (seat tiers) + manual sync trigger + backfill controls (spec §4, §6, §7.6)" />
        </Panel>
      </div>
    </>
  );
}
