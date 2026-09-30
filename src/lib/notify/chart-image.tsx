import { ImageResponse } from "next/og";
import type { CSSProperties } from "react";
import { CHART_PLOT, type ChartLayout } from "./chart";

const abs = (s: CSSProperties): CSSProperties => ({ position: "absolute", display: "flex", ...s });

/**
 * ChartLayout → PNG via next/og (Satori). Satori is flexbox-only and needs
 * `display: flex` on any element with more than one child, so everything is
 * absolutely-positioned boxes. Earlier buckets are dimmed; the current one is
 * full-strength with its total above.
 */
export async function renderChartPng(layout: ChartLayout): Promise<Uint8Array<ArrayBuffer>> {
  const image = new ImageResponse(
    (
      <div style={{ width: layout.width, height: layout.height, display: "flex", position: "relative", backgroundColor: "#ffffff", fontFamily: "sans-serif" }}>
        <div style={abs({ left: 24, top: 18, fontSize: 21, letterSpacing: 1.2, color: "#616061" })}>{layout.title}</div>
        {layout.gridlines.map((g) => (
          <div key={`g${g.y}`} style={abs({ left: 0, top: g.y - 12, width: layout.width, height: 24, alignItems: "center" })}>
            <div style={{ width: CHART_PLOT.left - 12, display: "flex", justifyContent: "flex-end", paddingRight: 10, fontSize: 19, color: "#8a8a8a" }}>{g.label}</div>
            <div style={{ flexGrow: 1, height: 2, backgroundColor: "#ececec", marginRight: layout.width - CHART_PLOT.right }} />
          </div>
        ))}
        {layout.bars.flatMap((b, i) => [
          ...b.segments.map((s, j) => (
            <div key={`s${i}-${j}`} style={abs({ left: b.x, top: s.y, width: b.w, height: s.h, backgroundColor: s.color, opacity: b.current ? 1 : 0.45 })} />
          )),
          <div key={`l${i}`} style={abs({ left: b.x - 30, top: CHART_PLOT.bottom + 10, width: b.w + 60, justifyContent: "center", fontSize: 19, color: b.current ? "#1d1c1d" : "#8a8a8a" })}>{b.label}</div>,
          ...(b.totalLabel
            ? [<div key={`t${i}`} style={abs({ left: b.x - 60, top: (b.segments.at(-1)?.y ?? CHART_PLOT.bottom) - 30, width: b.w + 120, justifyContent: "center", fontSize: 21, color: "#1d1c1d" })}>{b.totalLabel}</div>]
            : []),
        ])}
        <div style={abs({ left: CHART_PLOT.left, top: CHART_PLOT.bottom + 46, alignItems: "center" })}>
          {layout.legend.map((e, i) => (
            <div key={`k${i}`} style={{ display: "flex", alignItems: "center", marginRight: 26 }}>
              <div style={{ width: 18, height: 18, borderRadius: 4, backgroundColor: e.color, marginRight: 8 }} />
              <div style={{ fontSize: 19, color: "#555555" }}>{e.text}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    { width: layout.width, height: layout.height },
  );
  return new Uint8Array(await image.arrayBuffer()) as Uint8Array<ArrayBuffer>;
}
