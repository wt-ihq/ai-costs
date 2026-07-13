import type { CoverageCell, CoverageMonthRow } from "@/lib/queries/import-coverage";
import { formatUsd } from "@/lib/utils";

function Cell({ cell }: { cell: CoverageCell | null }) {
  if (!cell) return <span className="text-muted">—</span>;
  return (
    <span>
      <span className="tabular-nums">{formatUsd(cell.totalUsd)}</span>
      {cell.lastImport && <span className="ml-2 text-xs text-muted">imported {cell.lastImport}</span>}
    </span>
  );
}

/** Month × manual-source coverage grid — makes import gaps visible. */
export function ImportCoverage({ rows }: { rows: CoverageMonthRow[] }) {
  if (!rows.length) return <p className="text-sm text-muted">No manual imports yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th className="px-3 py-2 font-medium">Month</th>
            <th className="px-3 py-2 font-medium">ChatGPT seats</th>
            <th className="px-3 py-2 font-medium">ChatGPT credits</th>
            <th className="px-3 py-2 font-medium">Claude spend</th>
            <th className="px-3 py-2 font-medium">Claude seats</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className="border-b border-border/60 last:border-0">
              <td className="px-3 py-2 font-medium">{r.month}</td>
              <td className="px-3 py-2"><Cell cell={r.chatgptSeats} /></td>
              <td className="px-3 py-2"><Cell cell={r.chatgptCredits} /></td>
              <td className="px-3 py-2"><Cell cell={r.claudeSpend} /></td>
              <td className="px-3 py-2"><Cell cell={r.claudeSeats} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
