import type { CostType, Vendor } from "@/lib/types";

// Mirrors the CSS custom properties in globals.css so charts (which need
// concrete values) share the same vendor/cost-type encoding as the rest of
// the UI (spec §7 — consistent color across all pages).
export const VENDOR_COLORS: Record<Vendor, string> = {
  cursor: "#f59e0b",
  anthropic: "#d2845a",
  openai: "#10a37f",
  claude_team: "#c084fc",
  chatgpt_business: "#34d399",
  other: "#8b92a5",
};

export const COST_TYPE_COLORS: Record<CostType, string> = {
  seat: "#6ea8fe",
  subscription: "#a78bfa",
  overage: "#f472b6",
  metered: "#34d399",
};

// Reserved hues for user-added tools (recurring costs). Slot-stable: a tool's
// slot is stored at first entry and never reassigned.
export const OTHER_TOOL_PALETTE = [
  "#60a5fa", // blue
  "#f87171", // red
  "#facc15", // yellow
  "#2dd4bf", // teal
  "#e879f9", // fuchsia
  "#a3e635", // lime
  "#fb7185", // rose
  "#94a3b8", // slate
];
