/**
 * Anthropic token pricing for the per-key cost PROXY (the Cost API can't group
 * by key, so we price Usage-report tokens). Absolute rates need only be roughly
 * right: estimates are scaled per day to the authoritative Cost API total
 * (see estimateAndScale), so what matters is the relative mix across keys —
 * a stale table skews the per-key/per-model SPLIT even when day totals stay
 * exact.
 *
 * Base $/MTok (standard tier), current list rates as of 2026-06:
 *   Fable 5 $10/$50 · Opus 4.5+ $5/$25 · Sonnet $3/$15 · Haiku 4.5 $1/$5.
 * Cache/batch derived via the standard Anthropic multipliers. Current models
 * (Opus 4.7+, Fable) have NO long-context premium; the 2× is kept only for
 * older models' 200k-1M buckets, which is close enough for a relative weight.
 */
const BASE: Record<string, { input: number; output: number }> = {
  fable: { input: 10, output: 50 },
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

function family(model: string): keyof typeof BASE {
  const m = model.toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return "fable";
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
  const fam = family(r.model ?? "");
  const base = BASE[fam];
  // Long-context premium (>200k bucket) only ever applied to Sonnet-tier
  // pricing (2× input / 1.5× output); current Opus/Fable price 1M context at
  // standard rates.
  const longCtx = r.context_window === "200k-1M" && fam === "sonnet";
  const tierMult = r.service_tier === "batch" ? 0.5 : 1;
  const inP = base.input * (longCtx ? 2 : 1);
  const outP = base.output * (longCtx ? 1.5 : 1);

  const perMillion =
    (r.uncached_input_tokens ?? 0) * inP +
    (r.output_tokens ?? 0) * outP +
    (r.cache_read_input_tokens ?? 0) * inP * 0.1 +
    (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) * inP * 1.25 +
    (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) * inP * 2;

  return (perMillion / 1_000_000) * tierMult;
}
