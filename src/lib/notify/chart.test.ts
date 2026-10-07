import { describe, expect, it } from "vitest";
import { axisUsd, barUsd, CHART_CAPTION, CHART_HEADLINE, CHART_PLOT, chartLayout, niceMax } from "./chart";
import type { ChartBucket, ToolAmount } from "./digest";

const tools: ToolAmount[] = [
  { key: "cursor", label: "Cursor", color: "#f59e0b", usd: 380 },
  { key: "anthropic", label: "Anthropic API", color: "#d2845a", usd: 190 },
];
const buckets: ChartBucket[] = [
  { label: "14 Sep", current: false, byTool: { cursor: 300, anthropic: 150 }, totalUsd: 450 },
  { label: "21", current: true, byTool: { cursor: 380, anthropic: 190 }, totalUsd: 570 },
];

describe("barUsd", () => {
  it("fits a bar: cents under $10, whole dollars under $1k, then one-decimal thousands", () => {
    expect([barUsd(4.2), barUsd(38.6), barUsd(950), barUsd(1_000), barUsd(6_240), barUsd(12_345), barUsd(25_000), barUsd(123_456)]).toEqual([
      "$4.20", "$39", "$950", "$1k", "$6.2k", "$12.3k", "$25k", "$123k",
    ]);
  });
});

describe("niceMax / axisUsd", () => {
  it("rounds up to 1/2/2.5/5 × 10^k, with a floor for empty charts", () => {
    expect([niceMax(0), niceMax(38.2), niceMax(570), niceMax(1100), niceMax(210)]).toEqual([10, 50, 1000, 2000, 250]);
  });
  it("formats compact axis labels", () => {
    expect([axisUsd(0), axisUsd(25), axisUsd(125), axisUsd(1000), axisUsd(1250), axisUsd(2500)]).toEqual(["$0", "$25", "$125", "$1k", "$1.25k", "$2.5k"]);
  });
});

describe("chartLayout", () => {
  const l = chartLayout("YOU · USAGE, LAST 8 WEEKS", buckets, tools, tools);

  it("stacks the biggest tool at the bottom, sitting on the baseline", () => {
    const [first] = l.bars[1].segments;
    expect(first.color).toBe("#f59e0b");
    expect(first.y + first.h).toBeCloseTo(CHART_PLOT.bottom, 5);
    const top = l.bars[1].segments[1];
    expect(top.y + top.h).toBeCloseTo(first.y, 5);
  });

  it("labels every bar's total — the current one exactly, earlier ones compact — and keeps every bar inside the plot", () => {
    expect(l.bars.map((b) => b.totalLabel)).toEqual(["$450", "$570"]);
    const big = chartLayout("YOU", [
      { label: "a", current: false, byTool: { cursor: 12_345 }, totalUsd: 12_345 },
      { label: "b", current: false, byTool: {}, totalUsd: 0 },
      { label: "c", current: true, byTool: { cursor: 12_345 }, totalUsd: 12_345 },
    ], tools, tools);
    expect(big.bars.map((b) => b.totalLabel)).toEqual(["$12.3k", null, "$12,345"]);
    for (const b of l.bars) expect(b.x + b.w).toBeLessThanOrEqual(CHART_PLOT.right);
  });

  it("draws three gridlines on the section's own scale", () => {
    expect(l.gridlines.map((g) => g.label)).toEqual(["$0", "$500", "$1k"]);
    expect(l.gridlines[0].y).toBe(CHART_PLOT.bottom);
  });

  it("handles an all-zero chart (no segments, $0/$5/$10 axis)", () => {
    const empty = chartLayout("YOU", [{ label: "1", current: true, byTool: {}, totalUsd: 0 }], [], []);
    expect(empty.bars[0].segments).toEqual([]);
    expect(empty.gridlines.map((g) => g.label)).toEqual(["$0", "$5", "$10"]);
  });

  it("caps the legend at 4 tools plus a '+N more' entry", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, label: `Tool ${i}`, color: "#000", usd: 10 - i }));
    const legend = chartLayout("YOU", buckets, six, six).legend;
    expect(legend).toHaveLength(5);
    expect(legend[4].text).toBe("+2 more");
    expect(legend[0].text).toBe("Tool 0 $10.00");
  });
});

describe("chartLayout headline", () => {
  const headline = { total: "$570", trend: "up" as const, change: "27% vs previous week" };

  it("carries the section's headline and the bars' span caption into the image", () => {
    const l = chartLayout("YOU", buckets, tools, tools, { headline, caption: "LAST 8 WEEKS" });
    expect([l.headline, l.caption]).toEqual([headline, "LAST 8 WEEKS"]);
    expect([chartLayout("YOU", buckets, tools, tools).headline, chartLayout("YOU", buckets, tools, tools).caption]).toEqual([null, null]);
  });

  it("stacks headline, then caption, then plot — the tallest bar's total label clear of both", () => {
    const headlineBottom = CHART_HEADLINE.top + CHART_HEADLINE.size * 1.2;
    expect(CHART_CAPTION.top).toBeGreaterThanOrEqual(headlineBottom);
    expect(CHART_PLOT.top - 12).toBeGreaterThanOrEqual(CHART_CAPTION.top + CHART_CAPTION.size * 1.2); // top gridline label is 24px tall, centred on the line
    // every bar's total sits 30px above its top — a full-height bar's label must clear the caption
    expect(CHART_PLOT.top - 30).toBeGreaterThanOrEqual(CHART_CAPTION.top + CHART_CAPTION.size * 1.2);
  });
});
