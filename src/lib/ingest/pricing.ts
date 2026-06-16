/**
 * Anthropic token pricing for the per-key cost PROXY (the Cost API can't group
 * by key, so we price Usage-report tokens). Absolute rates need only be roughly
 * right: estimates are scaled per day to the authoritative Cost API total
 * (see estimateAndScale), so what matters is the relative mix across keys.
 *
 * Base $/MTok (standard tier, 0-200k context). Cache/long-context/batch derived
 * via the standard Anthropic multipliers.
 */
const BASE: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.8, output: 4 },
};

function family(model: string): keyof typeof BASE {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

export interface UsageResult {
  uncached_input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  api_key_id?: string | null;
  model?: string;
  service_tier?: string;
  context_window?: string;
}

/** Estimated USD for one usage result row. */
export function priceUsageResult(r: UsageResult): number {
  const base = BASE[family(r.model ?? "")];
  const ctx = r.context_window === "200k-1M" ? 2 : 1; // long-context premium
  const tierMult = r.service_tier === "batch" ? 0.5 : 1;
  const inP = base.input * ctx;
  const outP = base.output * ctx;

  const perMillion =
    (r.uncached_input_tokens ?? 0) * inP +
    (r.output_tokens ?? 0) * outP +
    (r.cache_read_input_tokens ?? 0) * inP * 0.1 +
    (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) * inP * 1.25 +
    (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) * inP * 2;

  return (perMillion / 1_000_000) * tierMult;
}
