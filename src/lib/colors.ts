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
};

export const COST_TYPE_COLORS: Record<CostType, string> = {
  seat: "#6ea8fe",
  overage: "#f472b6",
  metered: "#34d399",
};
