import { notFound } from "next/navigation";
import { PageHeader, Panel } from "@/components/ui";
import { ChatGptImport } from "@/components/chatgpt-import";
import { ClaudeSpendImport } from "@/components/claude-spend-import";
import { ClaudeRosterImport } from "@/components/claude-roster-import";
import { OpenAiCreditsImport } from "@/components/openai-credits-import";
import { SyncControls } from "@/components/sync-controls";
import { getRole } from "@/lib/auth-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildImportCoverage, getImportCoverageScope } from "@/lib/queries/import-coverage";
import { ImportCoverage } from "@/components/import-coverage";

export default async function ImportsPage() {
  // The nav only hides the link for viewers; the page itself must enforce it.
  if ((await getRole()) !== "admin") notFound();
  const supabase = getSupabaseAdminClient();
  const { facts, imports } = await getImportCoverageScope(supabase);
  const coverage = buildImportCoverage(facts, imports, new Date().toISOString().slice(0, 7));
  // Last successful credits-CSV import: drives the card's "imported through"
  // line and the rate prefill. Single row — no pagination needed.
  const { data: lastCsv } = await supabase
    .from("imports")
    .select("data_as_of, row_counts")
    .eq("source", "chatgpt_business")
    .eq("kind", "csv")
    .eq("status", "success")
    .order("created_at", { ascending: false })
    .limit(1);
  const importedThrough = (lastCsv?.[0]?.data_as_of as string | undefined) ?? null;
  const lastRate = (lastCsv?.[0]?.row_counts as { usd_per_credit?: number } | null)?.usd_per_credit;
  const defaultRate = typeof lastRate === "number" && lastRate > 0 ? lastRate : 0.04;
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
            Paste the analytics table. Each listed member is a $25 seat — credits shown in the preview are for
            reference only; paid credit overage comes from the credits CSV below. Fuzzy name-matched (no email).
          </p>
          <ChatGptImport />
        </Panel>

        <Panel>
          <h2 className="mb-1 text-sm font-medium">ChatGPT Business — credit usage (CSV)</h2>
          <p className="mb-4 text-xs text-muted">
            Additional (paid) credits per person, day, and model — this is the source of ChatGPT overage.{" "}
            <span className="text-foreground">
              Get the file at{" "}
              <a href="https://chatgpt.com/admin/billing" target="_blank" rel="noreferrer" className="underline">
                chatgpt.com/admin/billing
              </a>{" "}
              → <strong>Credits balance</strong> → ⋮ → <strong>Download usage data</strong>.
            </span>{" "}
            The export lags a day or two (the menu shows its &ldquo;Updated&rdquo; date). Any date range is fine — rows
            carry their own dates and re-imports replace overlaps.
          </p>
          <OpenAiCreditsImport importedThrough={importedThrough} defaultRate={defaultRate} />
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
