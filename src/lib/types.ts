// Domain types mirroring supabase/migrations/0001_init.sql.

export type Vendor =
  | "cursor"
  | "anthropic"
  | "openai"
  | "claude_team"
  | "chatgpt_business"
  | "other";

export type CostType = "seat" | "subscription" | "overage" | "metered";

export type MatchMethod = "exact_email" | "alias_rule" | "manual" | "unmatched";

export type SyncStatus = "running" | "success" | "failed";

export interface Employee {
  id: string;
  oktaId: string | null;
  email: string;
  fullName: string;
  department: string | null;
  site: string | null;
  employmentStatus: string | null;
  startDate: string | null;
  leaveDate: string | null;
}

/** One row per (source, day, grain entity). The single fact shape. */
export interface SpendFact {
  source: Vendor;
  day: string; // ISO date
  costType: CostType;
  entityKey: string;
  costUsd: number;
  tokens?: number | null;
  requests?: number | null;
  employeeId?: string | null;
  apiKeyId?: string | null;
  projectId?: string | null;
  model?: string | null;
  department?: string | null;
}

/**
 * One row of Cursor model-adoption usage per (day, user, model). This is
 * message volume from the Analytics API — NOT spend — so it has its own shape
 * and table (cursor_model_usage), kept out of SpendFact / spend_facts.
 */
export interface ModelUsageFact {
  day: string; // ISO date
  entityKey: string; // user email, lowercased
  model: string;
  messages: number;
  employeeId?: string | null;
}

export const VENDOR_LABEL: Record<Vendor, string> = {
  cursor: "Cursor",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  claude_team: "Claude Team",
  chatgpt_business: "ChatGPT Business",
  other: "Other tools",
};

/** "metered" = pay-as-you-go API usage; shown as "API" in the UI. */
export const COST_TYPE_LABEL: Record<CostType, string> = {
  seat: "Seat",
  subscription: "Subscription",
  overage: "Overage",
  metered: "API",
};

/**
 * Canonical display order for cost-type compositions (stacked bars, segmented
 * bars): fixed costs (seats, then tool subscriptions) sit at the base,
 * usage-driven spend on top.
 */
export const COST_TYPE_ORDER: CostType[] = ["seat", "subscription", "overage", "metered"];
