/**
 * Intent HQ brand colours for the Slack images (charts, the welcome banner). Surfaces: Truffle and
 * Warm Cream; accent: Sky Blue (graphics on cream — too light for text there; fine as text on
 * Truffle); Coral is the brand's only CTA colour, so images never use it. The warm greys are tuned
 * for text on Warm Cream (WCAG AA: totals and headings 13.9:1, labels ≥ 4.5:1). Tool colours in
 * charts stay the dashboard's, so a tool looks the same everywhere.
 */
export const BRAND = {
  truffle: "#231A14", // --intent-dark-truffle
  cream: "#F5E6D3", // --intent-light-warm-cream
  sky: "#00AFF4", // --intent-logo-sky-blue
  cocoa: "#4a3d33", // legend text on cream (8.5:1)
  muted: "#6b5a4c", // titles and secondary labels on cream (5.4:1)
  dim: "#76655a", // dimmed past-bar labels on cream (4.5:1)
  grid: "#e3d1bc", // gridlines on cream (decorative)
  highlight: "rgba(35, 26, 20, 0.07)", // Truffle tint behind the current bar (deepens the cream; bar colours untouched)
  creamMuted: "#cdbba6", // secondary text on Truffle (9.2:1)
} as const;
