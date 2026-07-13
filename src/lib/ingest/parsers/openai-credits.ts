import type { ParseRowError } from "./types";

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

export interface CreditUsageFact {
  email: string;
  name: string;
  day: string;
  model: string;
  credits: number;
  tokens: number | null;
  requests: number | null;
}

export interface OpenAiCreditsParseResult {
  facts: CreditUsageFact[];
  errors: ParseRowError[];
  minDay: string | null;
  maxDay: string | null;
  totalCredits: number;
}

const REQUIRED_COLUMNS = ["date_partition", "email", "usage_type", "usage_credits", "usage_quantity", "usage_units"];

/** Minimal RFC-4180 line splitter (quoted fields may contain commas). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/**
 * OpenAI admin "Credit Usage Report" CSV (chatgpt.com/admin/billing → Credits
 * balance → Download usage data). One row per day × user × usage_type; this
 * aggregates to one fact per (email, day, model label). Credits are the
 * ADDITIONAL (paid) pool — bundled seat usage is not in this file. Header
 * drift throws; bad rows become ParseRowErrors and good rows still import.
 */
export function parseOpenAiCreditsCsv(csv: string): OpenAiCreditsParseResult {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return { facts: [], errors: [{ line: 0, message: "empty file" }], minDay: null, maxDay: null, totalCredits: 0 };
  }

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col: Record<string, number> = Object.fromEntries(header.map((h, i) => [h, i]));
  const missing = REQUIRED_COLUMNS.filter((c) => col[c] === undefined);
  if (missing.length) {
    throw new Error(`Unrecognized credit-usage CSV — missing column(s): ${missing.join(", ")}. Did OpenAI change the export format?`);
  }

  const errors: ParseRowError[] = [];
  const byKey = new Map<string, CreditUsageFact>();
  let minDay: string | null = null;
  let maxDay: string | null = null;
  let totalCredits = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const day = (cells[col.date_partition] ?? "").trim();
    const email = (cells[col.email] ?? "").trim().toLowerCase();
    const usageType = (cells[col.usage_type] ?? "").trim();
    const credits = Number(cells[col.usage_credits]);
    const quantity = Number(cells[col.usage_quantity]);
    const units = (cells[col.usage_units] ?? "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !email || !usageType || !Number.isFinite(credits)) {
      errors.push({ line: i + 1, message: `unparseable row: "${lines[i].slice(0, 80)}"` });
      continue;
    }

    const model = modelLabelFromUsageType(usageType);
    const key = `${email}|${day}|${model}`;
    const fact = byKey.get(key) ?? {
      email,
      name: (cells[col.name] ?? "").trim() || email,
      day,
      model,
      credits: 0,
      tokens: null,
      requests: null,
    };
    fact.credits += credits;
    if (Number.isFinite(quantity) && quantity > 0) {
      if (units === "tokens") fact.tokens = (fact.tokens ?? 0) + quantity;
      else fact.requests = (fact.requests ?? 0) + quantity;
    }
    byKey.set(key, fact);
    totalCredits += credits;
    if (!minDay || day < minDay) minDay = day;
    if (!maxDay || day > maxDay) maxDay = day;
  }

  return { facts: [...byKey.values()], errors, minDay, maxDay, totalCredits };
}

/**
 * Replace-window for a credits import. Month-aligned start sweeps out old
 * month-stamped paste overage (stamped YYYY-MM-01) in covered months;
 * exclusive-end (day after the last row), matching every window in this repo.
 */
export function coveredWindow(minDay: string, maxDay: string): { startDate: string; endDate: string } {
  const [y, m, d] = maxDay.split("-").map(Number);
  const dayAfter = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { startDate: minDay.slice(0, 7) + "-01", endDate: dayAfter };
}
