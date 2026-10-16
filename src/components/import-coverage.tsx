"use client";

import { useState } from "react";
import { formatUsd } from "@/lib/utils";
import { monthName, type CoverageViewCell, type CoverageViewRow } from "@/lib/imports/checklist";

/** Months shown before "Show all". */
const RECENT = 6;

// The vendor colours are plain CSS variables (globals.css), not Tailwind theme colours.
const VENDOR_HEAD = {
  chatgpt_business: { color: "var(--color-vendor-chatgpt_business)", borderColor: "color-mix(in srgb, var(--color-vendor-chatgpt_business) 40%, transparent)" },
  claude_team: { color: "var(--color-vendor-claude_team)", borderColor: "color-mix(in srgb, var(--color-vendor-claude_team) 40%, transparent)" },
};

function Cell({ cell }: { cell: CoverageViewCell }) {
  if (cell.kind === "before") return <td className="px-3 py-2.5 text-muted/50">—</td>;
  if (cell.kind === "gap") return <td className="px-3 py-2.5 text-xs text-amber-300">no data</td>;
  return (
    <td className={cell.warn ? "bg-amber-400/10 px-3 py-2.5" : "px-3 py-2.5"}>
      <span className="tabular-nums">{formatUsd(cell.usd)}</span>
      {cell.note && <div className={cell.warn ? "text-[11px] text-amber-300" : "text-[11px] text-muted"}>{cell.note}</div>}
    </td>
  );
}

/** Month × manual-source coverage, grouped by vendor, newest first; gaps and estimates stand out. */
export function ImportCoverage({ rows }: { rows: CoverageViewRow[] }) {
  const [showAll, setShowAll] = useState(false);
  if (!rows.length) return <p className="text-sm text-muted">No manual imports yet.</p>;
  const shown = showAll ? rows : rows.slice(0, RECENT);
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th scope="col" rowSpan={2} className="border-b border-border px-3 py-2 align-bottom font-medium">Month</th>
              <th scope="colgroup" colSpan={2} className="border-b px-3 py-1.5 font-medium" style={VENDOR_HEAD.chatgpt_business}>ChatGPT Business</th>
              <th scope="colgroup" colSpan={2} className="border-b px-3 py-1.5 font-medium" style={VENDOR_HEAD.claude_team}>Claude Team</th>
            </tr>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th scope="col" className="px-3 py-2 font-medium">Credits</th>
              <th scope="col" className="px-3 py-2 font-medium">Seats</th>
              <th scope="col" className="px-3 py-2 font-medium">Spend</th>
              <th scope="col" className="px-3 py-2 font-medium">Seats</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.month} className="border-b border-border/60 last:border-0">
                <th scope="row" className="px-3 py-2.5 text-left font-medium">{monthName(r.month).slice(0, 3)} {r.month.slice(0, 4)}</th>
                <Cell cell={r.chatgptCredits} />
                <Cell cell={r.chatgptSeats} />
                <Cell cell={r.claudeSpend} />
                <Cell cell={r.claudeSeats} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > RECENT && (
        <button onClick={() => setShowAll((v) => !v)} className="text-xs text-accent hover:underline">
          {showAll ? "Show fewer" : `Show all ${rows.length} months`}
        </button>
      )}
    </div>
  );
}
