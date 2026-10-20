/**
 * Names for the sources runAllSyncs runs (run-all.ts), for Data → Sync. Client-safe.
 * sync-sources.test.ts fails if a source is added there without a name here.
 */
export const SYNC_SOURCE_LABEL: Record<string, string> = {
  okta: "Okta (people)",
  cursor: "Cursor",
  cursor_models: "Cursor model analytics",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  vercel: "Vercel",
  openrouter: "OpenRouter",
  chatgpt_seats: "ChatGPT seats (Okta group)",
  claude_seats: "Claude seats (Okta group)",
  claude_spend: "Claude Team spend (daily spread)",
  recurring: "Recurring tool costs",
  ecb: "Exchange rates (ECB)",
};

export const syncSourceLabel = (source: string): string => SYNC_SOURCE_LABEL[source] ?? source;
