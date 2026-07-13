const WORD_LABEL: Record<string, string> = { codex: "Codex", pro: "Pro", mini: "mini", fast: "fast" };
const word = (w: string) => WORD_LABEL[w] ?? w.charAt(0).toUpperCase() + w.slice(1);

/** "gpt_5_4_mini" → "GPT-5.4 mini"; "gpt_5_3_codex" → "GPT-5.3 Codex". */
function humanizeModelStem(stem: string): string {
  const m = /^gpt_(\d+)(?:_(\d+))?(.*)$/.exec(stem);
  if (!m) return stem.split("_").filter(Boolean).map(word).join(" ");
  const version = m[2] ? `${m[1]}.${m[2]}` : m[1];
  const rest = m[3].split("_").filter(Boolean).map(word).join(" ");
  return rest ? `GPT-${version} ${rest}` : `GPT-${version}`;
}

/**
 * Humanize an OpenAI credit-report `usage_type` into a model/surface label.
 * Input/cached-input/output token line items of one model map to the SAME
 * label so the parser can merge them into a single fact. Unknown types fall
 * back to a readable form of the raw string — rows are never dropped.
 */
export function modelLabelFromUsageType(usageType: string): string {
  // API token line items: api.<stem>[_YYYY_MM_DD]_text_<kind>_v_<n>
  const api = /^api\.(.+?)_text_(?:cached_input|cache_write_input|input|output)_v_\d+$/.exec(usageType);
  if (api) {
    let stem = api[1].replace(/_20\d{2}_\d{2}_\d{2}$/, ""); // strip model snapshot date
    const fast = stem.startsWith("codex_fast_");
    if (fast) stem = stem.slice("codex_fast_".length);
    return humanizeModelStem(stem) + (fast ? " Codex (fast)" : "");
  }
  // ChatGPT messages: chat.completion.<version-and-tier>
  const chat = /^chat\.completion\.(.+)$/.exec(usageType);
  if (chat) {
    const nums: string[] = [];
    const words: string[] = [];
    for (const part of chat[1].split(".")) (/^\d+$/.test(part) ? nums : words).push(part);
    const tier = words.length ? " " + words.map(word).join(" ") : "";
    return `GPT-${nums.join(".")}${tier} (chat)`;
  }
  if (usageType === "chat_agent.completion") return "ChatGPT Agent";
  if (usageType === "codex") return "Codex tasks";
  if (usageType.startsWith("codex.local")) return "Codex (local)";
  return usageType.replace(/[._]+/g, " ").trim();
}
