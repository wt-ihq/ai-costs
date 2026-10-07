import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { CSSProperties } from "react";
import { CHART_CAPTION, CHART_HEADLINE, CHART_PLOT, type ChartHeadline, type ChartLayout } from "./chart";

const abs = (s: CSSProperties): CSSProperties => ({ position: "absolute", display: "flex", ...s });

/** Intent's genome brand font and display orange (--io-color-genome-orange-display: large text on white). */
const FONT = "Barlow Semi Condensed";
const ORANGE = "#ca6001";
const GREY = "#616061";

/**
 * Bundled TTFs (Satori can't read woff2), read from disk at render time —
 * next.config's outputFileTracingIncludes ships them with the routes that
 * render charts. Custom fonts REPLACE next/og's default, and a glyph none of
 * them has is fetched from Google at render time, so ▲/▼ are drawn as SVG.
 */
let fonts: Promise<{ name: string; data: Buffer; weight: 400 | 500 | 700; style: "normal" }[]> | undefined;
function loadFonts() {
  fonts ??= Promise.all(
    ([["Regular", 400], ["Medium", 500], ["Bold", 700]] as const).map(async ([file, weight]) => ({
      name: FONT,
      data: await readFile(join(process.cwd(), "src/lib/notify/fonts", `BarlowSemiCondensed-${file}.ttf`)),
      weight,
      style: "normal" as const,
    })),
  );
  return fonts;
}

function Headline({ h }: { h: ChartHeadline }) {
  return (
    // Satori ignores baseline alignment: bottom-align, then lift the change onto the number's baseline.
    <div style={abs({ left: 24, top: CHART_HEADLINE.top, alignItems: "flex-end" })}>
      <div style={{ fontSize: CHART_HEADLINE.size, fontWeight: 700, color: ORANGE, lineHeight: 1.2, letterSpacing: -0.5 }}>{h.total}</div>
      <div style={{ display: "flex", alignItems: "center", marginLeft: 20, marginBottom: 14, fontSize: 26, fontWeight: 500, color: GREY }}>
        {h.trend && (
          <svg width="18" height="16" viewBox="0 0 18 16" style={{ marginRight: 8 }}>
            <path d={h.trend === "up" ? "M9 0 L18 16 L0 16 Z" : "M0 0 L18 0 L9 16 Z"} fill={GREY} />
          </svg>
        )}
        {h.change}
      </div>
    </div>
  );
}

/**
 * ChartLayout → PNG via next/og (Satori). Satori is flexbox-only and needs
 * `display: flex` on any element with more than one child, so everything is
 * absolutely-positioned boxes. Every bar carries its total; earlier buckets are
 * dimmed with a small grey total, the current one full-strength with its exact total.
 */
export async function renderChartPng(layout: ChartLayout): Promise<Uint8Array<ArrayBuffer>> {
  const image = new ImageResponse(
    (
      <div style={{ width: layout.width, height: layout.height, display: "flex", position: "relative", backgroundColor: "#ffffff", fontFamily: FONT }}>
        <div style={abs({ left: 24, top: 18, fontSize: 22, fontWeight: 500, letterSpacing: 1.4, color: GREY })}>{layout.title}</div>
        {layout.headline && <Headline h={layout.headline} />}
        {layout.caption && (
          <div style={abs({ left: 24, top: CHART_CAPTION.top, fontSize: CHART_CAPTION.size, fontWeight: 500, letterSpacing: 1.2, color: "#8a8a8a" })}>{layout.caption}</div>
        )}
        {layout.gridlines.map((g) => (
          <div key={`g${g.y}`} style={abs({ left: 0, top: g.y - 12, width: layout.width, height: 24, alignItems: "center" })}>
            <div style={{ width: CHART_PLOT.left - 12, display: "flex", justifyContent: "flex-end", paddingRight: 10, fontSize: 20, color: "#8a8a8a" }}>{g.label}</div>
            <div style={{ flexGrow: 1, height: 2, backgroundColor: "#ececec", marginRight: layout.width - CHART_PLOT.right }} />
          </div>
        ))}
        {layout.bars.flatMap((b, i) => [
          ...b.segments.map((s, j) => (
            <div key={`s${i}-${j}`} style={abs({ left: b.x, top: s.y, width: b.w, height: s.h, backgroundColor: s.color, opacity: b.current ? 1 : 0.45 })} />
          )),
          <div key={`l${i}`} style={abs({ left: b.x - 30, top: CHART_PLOT.bottom + 10, width: b.w + 60, justifyContent: "center", fontSize: 20, fontWeight: b.current ? 500 : 400, color: b.current ? "#1d1c1d" : "#8a8a8a" })}>{b.label}</div>,
          ...(b.totalLabel
            ? [
                <div
                  key={`t${i}`}
                  style={abs({
                    left: b.x - 60,
                    top: (b.segments.at(-1)?.y ?? CHART_PLOT.bottom) - (b.current ? 30 : 26),
                    width: b.w + 120,
                    justifyContent: "center",
                    fontSize: b.current ? 22 : 18,
                    fontWeight: b.current ? 500 : 400,
                    color: b.current ? "#1d1c1d" : "#8a8a8a",
                  })}
                >
                  {b.totalLabel}
                </div>,
              ]
            : []),
        ])}
        <div style={abs({ left: CHART_PLOT.left, top: CHART_PLOT.bottom + 46, width: layout.width - CHART_PLOT.left - 20, alignItems: "center", flexWrap: "wrap" })}>
          {layout.legend.map((e, i) => (
            <div key={`k${i}`} style={{ display: "flex", alignItems: "center", marginRight: 26, marginBottom: 6 }}>
              <div style={{ width: 18, height: 18, borderRadius: 4, backgroundColor: e.color, marginRight: 8 }} />
              <div style={{ fontSize: 20, color: "#555555" }}>{e.text}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    { width: layout.width, height: layout.height, fonts: await loadFonts() },
  );
  return new Uint8Array(await image.arrayBuffer()) as Uint8Array<ArrayBuffer>;
}
