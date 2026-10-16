import type { SupabaseClient } from "@supabase/supabase-js";
import { Panel } from "@/components/ui";
import { ClaudeSpendImport } from "@/components/claude-spend-import";
import { SeatRosterImport } from "@/components/seat-roster-import";
import { OpenAiCreditsImport } from "@/components/openai-credits-import";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildImportCoverage } from "@/lib/queries/import-coverage";
import { getImportCoverageScopeCached } from "@/lib/queries/cached";
import { ImportCoverage } from "@/components/import-coverage";
import { SeatMonthEntries, type SeatMonthEntryRow } from "@/components/seat-month-entries";
import { ImportChecklist, VendorDot } from "@/components/imports/import-checklist";
import { FxRateField, FxRateProvider } from "@/components/imports/fx-rate";
import { coverageView, importChecklist, shortDay } from "@/lib/imports/checklist";

/** Every seat_month_entries row, newest month first, paged past PostgREST's 1000-row cap (gotcha #1). */
async function fetchSeatEntries(supabase: SupabaseClient): Promise<SeatMonthEntryRow[]> {
  const PAGE = 1000;
  const out: SeatMonthEntryRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("seat_month_entries")
      .select("vendor, seat_type, month, seats, price_usd, price_gbp, fx_rate")
      // (vendor, seat_type, month) is unique, so pages can't overlap.
      .order("month", { ascending: false })
      .order("vendor")
      .order("seat_type")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`seat_month_entries: ${error.message}`);
    out.push(...(data ?? []).map((r) => ({
      vendor: r.vendor as string,
      seatType: r.seat_type as string,
      month: (r.month as string).slice(0, 7),
      seats: Number(r.seats),
      priceUsd: Number(r.price_usd),
      priceGbp: r.price_gbp === null ? null : Number(r.price_gbp),
      fxRate: r.fx_rate === null ? null : Number(r.fx_rate),
    })));
    if (!data || data.length < PAGE) return out;
  }
}

function VendorHeading({ id, vendor, children }: { id: string; vendor: "chatgpt_business" | "claude_team"; children: React.ReactNode }) {
  return (
    <h2 id={id} className="flex items-center gap-2 text-base font-semibold">
      <VendorDot vendor={vendor} size={10} />
      {children}
    </h2>
  );
}

/**
 * The monthly manual-import workflow (admin): what this month still needs, then one column per vendor
 * (the regular imports first, seat tiers tucked away), then the coverage history.
 */
export async function ImportsTab() {
  const supabase = getSupabaseAdminClient();
  const { facts, imports } = await getImportCoverageScopeCached();
  const today = new Date().toISOString().slice(0, 10);
  const nowMonth = today.slice(0, 7);
  const coverage = buildImportCoverage(facts, imports, nowMonth);
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
  const seatEntries = await fetchSeatEntries(supabase);

  const checklist = importChecklist({ coverage, imports, seatEntries, today });
  const lastSpendPaste = imports
    .filter((r) => r.status === "success" && r.source === "claude_team" && r.kind === "clipboard")
    .reduce<string | null>((a, r) => (a === null || r.dataAsOf > a ? r.dataAsOf : a), null);
  // The Claude column's shared £ → $ rate starts from the latest seat month saved with one.
  const claudeRate = String(seatEntries.find((e) => e.vendor === "claude_team" && e.fxRate)?.fxRate ?? 1.27);

  return (
    <div className="grid gap-6">
      <Panel>
        <ImportChecklist checklist={checklist} asOf={shortDay(today)} />
      </Panel>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        {/* ChatGPT Business */}
        <section aria-labelledby="imports-chatgpt" className="space-y-3">
          <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
            <VendorHeading id="imports-chatgpt" vendor="chatgpt_business">ChatGPT Business</VendorHeading>
            <span className="text-xs text-muted">Members sync nightly from Okta <span className="text-foreground">access-chatgpt</span> · priced in $</span>
          </div>

          <Panel id="chatgpt-credits">
            <h3 className="mb-1 text-sm font-medium">Credit usage</h3>
            <p className="mb-4 text-xs text-muted">Paid credits per person, day and model: the source of ChatGPT overage. Any date range is fine; re-imports replace overlapping days.</p>
            <OpenAiCreditsImport importedThrough={importedThrough} defaultRate={defaultRate} />
            <details className="mt-3 text-xs text-muted">
              <summary className="cursor-pointer text-accent">How to get this file</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>
                  Open{" "}
                  <a href="https://chatgpt.com/admin/billing" target="_blank" rel="noreferrer" className="underline">chatgpt.com/admin/billing</a>
                  {" "}→ <strong>Credits balance</strong> → ⋮ → <strong>Download usage data</strong>.
                </li>
                <li>The export lags a day or two; its menu shows the &ldquo;Updated&rdquo; date.</li>
                <li>Download the full report, or start from a month boundary: a re-import starting mid-month can drop earlier days in that month.</li>
              </ol>
            </details>
          </Panel>

          <Panel id="chatgpt-seats">
            <h3 className="mb-1 text-sm font-medium">Seats</h3>
            <p className="mb-4 text-xs text-muted">Each month&rsquo;s seat counts per tier, from the invoice. Without them the month is estimated from synced members, and the Okta group doesn&rsquo;t hold everyone billed.</p>
            <SeatMonthEntries vendor="chatgpt_business" entries={seatEntries} />
          </Panel>

          <details className="rounded-xl border border-border bg-surface px-5 py-4">
            <summary className="cursor-pointer text-sm font-medium">
              Seat tiers <span className="text-xs font-normal text-muted">· only when someone moves between Standard and Premium</span>
            </summary>
            <p className="my-3 text-xs text-muted">
              Upload the workspace members CSV (Name, Email, Role, Status, Seat Tier). It sets each member&rsquo;s tier and re-prices the current month.
            </p>
            <SeatRosterImport vendor="chatgpt_business" />
          </details>
        </section>

        {/* Claude Team: one £ → $ rate for the column */}
        <FxRateProvider initial={claudeRate}>
          <section aria-labelledby="imports-claude" className="space-y-3">
            <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
              <VendorHeading id="imports-claude" vendor="claude_team">Claude Team</VendorHeading>
              <FxRateField />
            </div>

            <Panel id="claude-spend">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">Spend, month to date</h3>
                {lastSpendPaste && <span className="text-xs text-muted">Last pasted as of {shortDay(lastSpendPaste)}</span>}
              </div>
              <p className="mb-4 text-xs text-muted">Paste the &ldquo;MTD spend&rdquo; table. Email-matched; each paste replaces that month&rsquo;s figures, so paste again any time.</p>
              <ClaudeSpendImport />
            </Panel>

            <Panel id="claude-seats">
              <h3 className="mb-1 text-sm font-medium">Seats</h3>
              <p className="mb-4 text-xs text-muted">Each month&rsquo;s seat counts per tier, from the invoice, in £. Without them the month is estimated from synced members.</p>
              <SeatMonthEntries vendor="claude_team" entries={seatEntries} />
            </Panel>

            <details className="rounded-xl border border-border bg-surface px-5 py-4">
              <summary className="cursor-pointer text-sm font-medium">
                Seat tiers <span className="text-xs font-normal text-muted">· only when someone&rsquo;s tier changes</span>
              </summary>
              <p className="my-3 text-xs text-muted">
                Membership syncs nightly from the Okta <strong>access-claude</strong> group. Upload the roster CSV (Name, Email, Role, Status, Seat Tier) to set standard/premium per member; it re-prices the current month.
              </p>
              <SeatRosterImport vendor="claude_team" />
            </details>
          </section>
        </FxRateProvider>
      </div>

      <Panel>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Coverage history</h2>
          <div className="flex flex-wrap gap-4 text-xs text-muted">
            <span><span className="text-amber-300">no data</span>: a gap, or nothing to import that month</span>
            <span><span className="text-muted/50">—</span> before this was tracked</span>
          </div>
        </div>
        <ImportCoverage rows={coverageView(coverage, seatEntries, nowMonth)} />
      </Panel>
    </div>
  );
}
