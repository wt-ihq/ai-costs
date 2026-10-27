import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { CSSProperties } from "react";
import { BRAND } from "./brand";
import { CHART_CAPTION, CHART_HEADLINE, CHART_PLOT, type ChartHeadline, type ChartLayout } from "./chart";

const abs = (s: CSSProperties): CSSProperties => ({ position: "absolute", display: "flex", ...s });

/** Intent's brand font; colours from brand.ts (Warm Cream surface, Truffle type). */
const FONT = "Barlow Semi Condensed";

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
      <div style={{ fontSize: CHART_HEADLINE.size, fontWeight: 700, color: BRAND.truffle, lineHeight: 1.2, letterSpacing: -0.5 }}>{h.total}</div>
      <div style={{ display: "flex", alignItems: "center", marginLeft: 20, marginBottom: 14, fontSize: 26, fontWeight: 500, color: BRAND.muted }}>
        {h.trend && (
          <svg width="18" height="16" viewBox="0 0 18 16" style={{ marginRight: 8 }}>
            <path d={h.trend === "up" ? "M9 0 L18 16 L0 16 Z" : "M0 0 L18 0 L9 16 Z"} fill={BRAND.muted} />
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
 * absolutely-positioned boxes. Every bar carries its total. The current bar is
 * full-strength in the dashboard's tool colours, with its label in a Truffle pill
 * and a bold total; earlier ones are faded to 45% with a small grey total.
 */
export async function renderChartPng(layout: ChartLayout): Promise<Uint8Array<ArrayBuffer>> {
  const dense = layout.bars.length > 8; // daily: the current bar's exact total must stay clear of its neighbour's
  const image = new ImageResponse(
    (
      <div style={{ width: layout.width, height: layout.height, display: "flex", position: "relative", backgroundColor: BRAND.cream, fontFamily: FONT }}>
        <div style={abs({ left: 24, top: 16, fontSize: 26, fontWeight: 700, letterSpacing: 1.6, color: BRAND.truffle })}>{layout.title}</div>
        {layout.headline && <Headline h={layout.headline} />}
        {layout.caption && (
          <div style={abs({ left: 24, top: CHART_CAPTION.top, fontSize: CHART_CAPTION.size, fontWeight: 500, letterSpacing: 1.2, color: BRAND.dim })}>{layout.caption}</div>
        )}
        {layout.gridlines.map((g) => (
          <div key={`g${g.y}`} style={abs({ left: 0, top: g.y - 12, width: layout.width, height: 24, alignItems: "center" })}>
            <div style={{ width: CHART_PLOT.left - 12, display: "flex", justifyContent: "flex-end", paddingRight: 10, fontSize: 20, color: BRAND.dim }}>{g.label}</div>
            <div style={{ flexGrow: 1, height: 2, backgroundColor: BRAND.grid, marginRight: layout.width - CHART_PLOT.right }} />
          </div>
        ))}
        {layout.bars.flatMap((b, i) => [
          ...b.segments.map((s, j) => (
            <div key={`s${i}-${j}`} style={abs({ left: b.x, top: s.y, width: b.w, height: s.h, backgroundColor: s.color, opacity: b.current ? 1 : 0.45 })} />
          )),
          b.current ? (
            <div key={`l${i}`} style={abs({ left: b.x - 30, top: CHART_PLOT.bottom + 7, width: b.w + 60, justifyContent: "center" })}>
              <div style={{ display: "flex", padding: "1px 10px 2px", borderRadius: 999, backgroundColor: BRAND.truffle, color: BRAND.cream, fontSize: 20, fontWeight: 700 }}>{b.label}</div>
            </div>
          ) : (
            <div key={`l${i}`} style={abs({ left: b.x - 30, top: CHART_PLOT.bottom + 10, width: b.w + 60, justifyContent: "center", fontSize: 20, color: BRAND.dim })}>{b.label}</div>
          ),
          ...(b.totalLabel
            ? [
                <div
                  key={`t${i}`}
                  style={abs({
                    left: b.x - 60,
                    top: (b.segments.at(-1)?.y ?? CHART_PLOT.bottom) - (b.current ? 32 : 26),
                    width: b.w + 120,
                    justifyContent: "center",
                    fontSize: b.current ? (dense ? 22 : 24) : 18,
                    fontWeight: b.current ? 700 : 400,
                    color: b.current ? BRAND.truffle : BRAND.dim,
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
              <div style={{ fontSize: 20, color: BRAND.cocoa }}>{e.text}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    { width: layout.width, height: layout.height, fonts: await loadFonts() },
  );
  return new Uint8Array(await image.arrayBuffer()) as Uint8Array<ArrayBuffer>;
}

/** The welcome banner's size: the charts' width, so the two line up in Slack. */
export const BANNER_W = 920;
export const BANNER_H = 288;

/**
 * The welcome banner (a person's first message, intro.ts): one image for everyone, on brand — a
 * Truffle band, "AI Spend" in Warm Cream, a Sky Blue label and rising bars.
 */
export async function renderWelcomeBannerPng(): Promise<Uint8Array<ArrayBuffer>> {
  const bars = [0.34, 0.52, 0.7, 1];
  const image = new ImageResponse(
    (
      <div style={{ width: BANNER_W, height: BANNER_H, display: "flex", backgroundColor: BRAND.truffle, fontFamily: FONT }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1, flexShrink: 1, minWidth: 0, paddingLeft: 48 }}>
          <div style={{ fontSize: 24, fontWeight: 500, letterSpacing: 3, color: BRAND.sky }}>INTENT HQ</div>
          <div style={{ display: "flex", fontSize: 72, fontWeight: 700, lineHeight: 1.05, color: BRAND.cream, marginTop: 10 }}>AI Spend</div>
          <div style={{ fontSize: 32, fontWeight: 500, color: BRAND.creamMuted, marginTop: 14 }}>A regular summary of spending on AI tools</div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", width: 200, flexShrink: 0, paddingTop: 64, paddingBottom: 56, paddingRight: 48 }}>
          {bars.map((h, i) => (
            <div key={i} style={{ display: "flex", flexGrow: 1, height: `${h * 100}%`, marginLeft: i ? 16 : 0, borderRadius: 4, backgroundColor: BRAND.sky, opacity: [0.35, 0.5, 0.7, 1][i] }} />
          ))}
        </div>
      </div>
    ),
    { width: BANNER_W, height: BANNER_H, fonts: await loadFonts() },
  );
  return new Uint8Array(await image.arrayBuffer()) as Uint8Array<ArrayBuffer>;
}
