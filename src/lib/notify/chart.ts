import { formatUsd } from "@/lib/utils";
import type { ChartBucket, ToolAmount } from "./digest";

/** Rendered at 2× (Slack displays ~460px wide) so bars stay crisp on retina screens. */
export const CHART_W = 920;
export const CHART_H = 554;
/** The section's total, drawn big under the title (Slack text can't be sized or coloured). */
export const CHART_HEADLINE = { top: 50, size: 72 } as const;
/** "LAST 6 MONTHS" — captions the bars, kept apart from the headline so it can't read as the total's period. */
export const CHART_CAPTION = { top: 150, size: 19 } as const;
export const CHART_PLOT = { left: 88, right: 900, top: 210, bottom: 430 } as const;
const LEGEND_MAX = 4;

export interface ChartSegment { y: number; h: number; color: string }
export interface ChartBar { x: number; w: number; label: string; current: boolean; segments: ChartSegment[]; totalLabel: string | null }
/** `change` reads after the arrow `trend` draws ("27% vs previous week"); no trend = no arrow. */
export interface ChartHeadline { total: string; trend: "up" | "down" | null; change: string }
export interface ChartLayout {
  width: number;
  height: number;
  title: string;
  headline: ChartHeadline | null;
  caption: string | null;
  gridlines: { y: number; label: string }[];
  bars: ChartBar[];
  legend: { color: string; text: string }[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function niceMax(v: number): number {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** A bar's total, short enough to sit over a 14-day chart's bars: "$4.20", "$950", "$6.2k", "$123k". */
export function barUsd(v: number): string {
  if (v < 10) return `$${v.toFixed(2)}`;
  if (v < 999.5) return `$${Math.round(v)}`;
  if (v < 99_950) return `$${(Math.round(v / 100) / 10).toLocaleString("en-US")}k`;
  return `$${Math.round(v / 1000)}k`;
}

export function axisUsd(v: number): string {
  return v >= 1000 ? `$${(v / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })}k` : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * Pure geometry for one section's chart: stacked bars per bucket in
 * `chartTools` order (largest tool at the bottom), each section on its OWN
 * scale — which is why the title is drawn into the image.
 */
export function chartLayout(
  title: string,
  buckets: ChartBucket[],
  chartTools: ToolAmount[],
  legendTools: ToolAmount[],
  { headline = null, caption = null }: { headline?: ChartHeadline | null; caption?: string | null } = {},
): ChartLayout {
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.totalUsd)));
  const plotH = CHART_PLOT.bottom - CHART_PLOT.top;
  const yOf = (usd: number) => CHART_PLOT.bottom - (usd / max) * plotH;
  const step = (CHART_PLOT.right - CHART_PLOT.left) / Math.max(1, buckets.length);
  const w = Math.max(4, Math.round(step * 0.66));

  const bars = buckets.map((b, i) => {
    let base = 0;
    const segments: ChartSegment[] = [];
    for (const t of chartTools) {
      const usd = b.byTool[t.key] ?? 0;
      if (usd <= 0) continue;
      const top = yOf(base + usd);
      segments.push({ y: r1(top), h: r1(yOf(base) - top), color: t.color });
      base += usd;
    }
    return {
      x: r1(CHART_PLOT.left + i * step + (step - w) / 2),
      w,
      label: b.label,
      current: b.current,
      segments,
      // Every bar's total; the current one exact, to match the headline above it.
      totalLabel: b.totalUsd <= 0 ? null : b.current ? formatUsd(b.totalUsd) : barUsd(b.totalUsd),
    };
  });

  const legend = legendTools.slice(0, LEGEND_MAX).map((t) => ({ color: t.color, text: `${t.label} ${formatUsd(t.usd)}` }));
  if (legendTools.length > LEGEND_MAX) legend.push({ color: "#8b92a5", text: `+${legendTools.length - LEGEND_MAX} more` });

  return {
    width: CHART_W,
    height: CHART_H,
    title,
    headline,
    caption,
    gridlines: [0, max / 2, max].map((v) => ({ y: r1(yOf(v)), label: axisUsd(v) })),
    bars,
    legend,
  };
}
