import { VENDOR_COLORS } from "@/lib/colors";
import { formatWholeUsd } from "@/lib/utils";
import type { RecTool, RecWeekCell } from "@/lib/recommendations/rule";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dm(day: string): { d: number; m: string } {
  const [, m, d] = day.split("-").map(Number);
  return { d, m: MON[m - 1] };
}

/** `19 to 25 Oct` (the exclusive end is shown as the previous day). */
function weekLabel(from: string, toExclusive: string): string {
  const last = new Date(Date.parse(`${toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const a = dm(from);
  const b = dm(last);
  return a.m === b.m ? `${a.d} to ${b.d} ${b.m}` : `${a.d} ${a.m} to ${b.d} ${b.m}`;
}

const EXTRA_LABEL: Record<RecTool, string> = {
  cursor: "on-demand",
  claude_team: "extra usage",
  chatgpt_business: "credits",
};

export function WeekBars({ cells, tool }: { cells: RecWeekCell[]; tool: RecTool }) {
  const max = Math.max(...cells.map((c) => c.extraUsd), 0);
  return (
    <span className="inline-flex h-[18px] items-end gap-0.5 align-middle">
      {cells.map((c) => {
        const h = max > 0 ? Math.max(2, Math.round((c.extraUsd / max) * 18)) : 2;
        let text = `${weekLabel(c.from, c.toExclusive)} · ${formatWholeUsd(c.extraUsd)} ${EXTRA_LABEL[tool]}`;
        if (tool === "cursor" && c.requests != null) {
          text += ` · ${c.requests.toLocaleString("en-US")} requests`;
          if (c.activeDays != null) text += ` · ${c.activeDays} active days`;
        }
        return (
          <span key={c.from} className="group relative inline-flex h-full items-end">
            <i
              className="block w-[7px] rounded-[1px]"
              style={{ height: h, background: VENDOR_COLORS[tool], opacity: 0.8 }}
            />
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-foreground shadow-lg group-hover:block"
            >
              {text}
            </span>
          </span>
        );
      })}
    </span>
  );
}
