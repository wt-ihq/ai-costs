"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { recentWindow, runAllSyncs, type SyncOutcome } from "@/lib/ingest/run-all";
import { syncCursor } from "@/lib/ingest/run-cursor";
import { syncAnthropic, syncOpenAI } from "@/lib/ingest/run-platforms";
import { parseChatGptMemberTable, normalizeName } from "@/lib/ingest/parsers/chatgpt-clipboard";
import { parseClaudeSpend } from "@/lib/ingest/parsers/claude-spend";
import { parseClaudeRoster } from "@/lib/ingest/parsers/claude-roster";
import { parseOpenAiCreditsCsv, coveredWindow, type CreditUsageFact } from "@/lib/ingest/parsers/openai-credits";
import { matchByName } from "@/lib/ingest/identity";
import { loadEmployeeNames, loadEmployeesFull, upsertSpendFacts, replaceWindowFacts, type ResolvedFact } from "@/lib/ingest/persist";
import type { SupabaseClient } from "@supabase/supabase-js";

/** seat_prices as a `${vendor}:${seat_type}` -> USD map. */
async function loadSeatPrices(supabase: SupabaseClient): Promise<Record<string, number>> {
  const { data } = await supabase.from("seat_prices").select("vendor, seat_type, monthly_price_usd");
  return Object.fromEntries((data ?? []).map((p) => [`${p.vendor}:${p.seat_type}`, Number(p.monthly_price_usd)]));
}

export interface ChatGptPreviewRow {
  name: string;
  creditsSpent: number;
  employeeId: string | null;
  employeeName: string | null;
  confidence: "high" | "low" | "none";
}

export interface ChatGptPreview {
  rows: ChatGptPreviewRow[];
  errors: { line: number; message: string }[];
}

/** Parse the pasted member table and fuzzy-match each member to an employee. */
export async function previewChatGptImport(text: string): Promise<ChatGptPreview> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const employees = await loadEmployeeNames(supabase);
  const byId = new Map(employees.map((e) => [e.id, e.fullName]));

  const { members, errors } = parseChatGptMemberTable(text);

  const rows: ChatGptPreviewRow[] = members.map((m) => {
    const match = matchByName(m.name, employees);
    return {
      name: m.name,
      creditsSpent: m.creditsSpent,
      employeeId: match.confidence === "high" ? match.employeeId : null,
      employeeName: match.employeeId ? byId.get(match.employeeId) ?? null : null,
      confidence: match.confidence,
    };
  });

  return { rows, errors };
}

export interface ChatGptCommitResult {
  written: number;
  attributed: number;
  queued: number;
  seats?: number;
}

/** Commit reviewed rows: upsert seat facts, identities, and an import log. */
export async function commitChatGptImport(
  rows: ChatGptPreviewRow[],
  asOf: string,
): Promise<ChatGptCommitResult> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  // Never delete a month when the insert would be empty (gotcha #4).
  if (!rows.length) throw new Error("Nothing to import — the preview has no rows.");
  const day = asOf.slice(0, 7) + "-01"; // monthly snapshot, upsert-replace
  const seatPrice = (await loadSeatPrices(supabase))["chatgpt_business:chatgpt"] ?? 25;

  // Snapshot semantics: clear this month's ChatGPT *seat* facts only — overage
  // now comes from the credit-usage CSV import and must never be clobbered here.
  await supabase.from("spend_facts").delete().eq("source", "chatgpt_business").eq("cost_type", "seat").eq("day", day);

  const empId = (r: ChatGptPreviewRow) => (r.confidence === "high" ? r.employeeId : null);

  // Every listed member holds a seat.
  const seatFacts: ResolvedFact[] = rows.map((r) => ({
    source: "chatgpt_business",
    day,
    costType: "seat",
    entityKey: normalizeName(r.name),
    costUsd: seatPrice,
    employeeId: empId(r),
  }));

  const written = await upsertSpendFacts(supabase, seatFacts);

  // Record confirmed identity mappings (name -> employee).
  const identities = rows
    .filter((r) => r.confidence === "high" && r.employeeId)
    .map((r) => ({
      vendor: "chatgpt_business" as const,
      external_id: normalizeName(r.name),
      employee_id: r.employeeId,
      match_method: "alias_rule" as const,
    }));
  if (identities.length) {
    await supabase.from("identities").upsert(identities, { onConflict: "vendor,external_id" });
  }

  const attributed = seatFacts.filter((f) => f.employeeId).length;
  const queued = rows.length - attributed;
  await supabase.from("imports").insert({
    source: "chatgpt_business",
    kind: "clipboard",
    data_as_of: asOf,
    status: "success",
    row_counts: { members: rows.length, seats: rows.length, attributed, queued },
  });

  return { written, attributed, queued, seats: rows.length };
}

// ---- OpenAI credit-usage CSV (additional/paid credits) ---------------------

export interface OpenAiCreditsFact extends CreditUsageFact {
  usd: number;
  employeeId: string | null;
}

export interface OpenAiCreditsUserRow {
  email: string;
  name: string;
  credits: number;
  usd: number;
  matched: boolean;
  employeeName: string | null;
}

export interface OpenAiCreditsPreview {
  facts: OpenAiCreditsFact[];
  users: OpenAiCreditsUserRow[];
  errors: { line: number; message: string }[];
  totalCredits: number;
  totalUsd: number;
  minDay: string | null;
  maxDay: string | null;
  matchedCount: number;
  modelCount: number;
}

/** Parse the credit-usage CSV, price credits at the given rate, exact-match emails. */
export async function previewOpenAiCreditsImport(
  csv: string,
  usdPerCredit: number,
): Promise<OpenAiCreditsPreview> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const employees = await loadEmployeesFull(supabase);
  const byEmail = new Map(employees.map((e) => [e.email.toLowerCase(), e]));

  const parsed = parseOpenAiCreditsCsv(csv);
  const facts: OpenAiCreditsFact[] = parsed.facts.map((f) => ({
    ...f,
    usd: Math.round(f.credits * usdPerCredit * 100) / 100,
    employeeId: byEmail.get(f.email)?.id ?? null,
  }));

  const users = new Map<string, OpenAiCreditsUserRow>();
  for (const f of facts) {
    const u = users.get(f.email) ?? {
      email: f.email,
      name: f.name,
      credits: 0,
      usd: 0,
      matched: !!f.employeeId,
      employeeName: byEmail.get(f.email)?.fullName ?? null,
    };
    u.credits += f.credits;
    u.usd = Math.round((u.usd + f.usd) * 100) / 100;
    users.set(f.email, u);
  }
  const userRows = [...users.values()].sort((a, b) => b.usd - a.usd);

  return {
    facts,
    users: userRows,
    errors: parsed.errors,
    totalCredits: parsed.totalCredits,
    totalUsd: Math.round(facts.reduce((s, f) => s + f.usd, 0) * 100) / 100,
    minDay: parsed.minDay,
    maxDay: parsed.maxDay,
    matchedCount: userRows.filter((u) => u.matched).length,
    modelCount: new Set(facts.map((f) => f.model)).size,
  };
}

export interface OpenAiCreditsCommitResult {
  written: number;
  attributed: number;
  queued: number;
  from: string;
  to: string;
}

/** Window-replace the overage slice only — seat facts in the window survive. */
export async function commitOpenAiCreditsImport(
  facts: OpenAiCreditsFact[],
  usdPerCredit: number,
  fileName: string | null,
): Promise<OpenAiCreditsCommitResult> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  // Never delete a window when the insert would be empty (gotcha #4).
  if (!facts.length) throw new Error("Nothing to import — the preview has no rows.");

  let minDay = facts[0].day;
  let maxDay = facts[0].day;
  for (const f of facts) {
    if (f.day < minDay) minDay = f.day;
    if (f.day > maxDay) maxDay = f.day;
  }
  const window = coveredWindow(minDay, maxDay);

  const resolved: ResolvedFact[] = facts.map((f) => ({
    source: "chatgpt_business",
    day: f.day,
    costType: "overage",
    entityKey: f.email,
    costUsd: f.usd,
    tokens: f.tokens,
    requests: f.requests,
    model: f.model,
    employeeId: f.employeeId,
  }));
  const written = await replaceWindowFacts(supabase, "chatgpt_business", window, resolved, { costType: "overage" });

  // Record confirmed identity mappings (email → employee).
  const identities = [
    ...new Map(facts.filter((f) => f.employeeId).map((f) => [f.email, f.employeeId])).entries(),
  ].map(([email, employeeId]) => ({
    vendor: "chatgpt_business" as const,
    external_email: email,
    employee_id: employeeId,
    match_method: "exact_email" as const,
  }));
  if (identities.length) {
    await supabase.from("identities").upsert(identities, { onConflict: "vendor,external_email" });
  }

  const attributed = resolved.filter((f) => f.employeeId).length;
  await supabase.from("imports").insert({
    source: "chatgpt_business",
    kind: "csv",
    file_name: fileName,
    data_as_of: maxDay,
    status: "success",
    row_counts: {
      facts: resolved.length,
      users: new Set(facts.map((f) => f.email)).size,
      attributed,
      queued: resolved.length - attributed,
      total_credits: Math.round(facts.reduce((s, f) => s + f.credits, 0)),
      usd_per_credit: usdPerCredit,
      from: minDay,
      to: maxDay,
    },
  });

  revalidatePath("/");
  return { written, attributed, queued: resolved.length - attributed, from: minDay, to: maxDay };
}

// ---- Claude Team MTD spend (paste) -----------------------------------------

export interface ClaudePreviewRow {
  name: string;
  email: string;
  mtdGbp: number;
  usd: number;
  employeeId: string | null;
  employeeName: string | null;
  matched: boolean;
}

export interface ClaudePreview {
  rows: ClaudePreviewRow[]; // sorted by spend desc, only non-zero
  zeroCount: number;
  errors: { line: number; message: string }[];
  totalGbp: number;
  totalUsd: number;
  matchedCount: number;
}

/** Parse the pasted Claude MTD table; match by email; convert GBP→USD. */
export async function previewClaudeSpendImport(
  text: string,
  gbpToUsd: number,
): Promise<ClaudePreview> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const { data: emps } = await supabase.from("employees").select("id, email, full_name");
  const byEmail = new Map((emps ?? []).map((e) => [(e.email as string).toLowerCase(), e]));

  const { rows: parsed, errors } = parseClaudeSpend(text);
  const nonZero = parsed.filter((r) => r.mtdGbp > 0);

  const rows: ClaudePreviewRow[] = nonZero
    .map((r) => {
      const e = byEmail.get(r.email);
      return {
        name: r.name,
        email: r.email,
        mtdGbp: r.mtdGbp,
        usd: Math.round(r.mtdGbp * gbpToUsd * 100) / 100,
        employeeId: (e?.id as string) ?? null,
        employeeName: (e?.full_name as string) ?? null,
        matched: !!e,
      };
    })
    .sort((a, b) => b.mtdGbp - a.mtdGbp);

  return {
    rows,
    zeroCount: parsed.length - nonZero.length,
    errors,
    totalGbp: nonZero.reduce((s, r) => s + r.mtdGbp, 0),
    totalUsd: rows.reduce((s, r) => s + r.usd, 0),
    matchedCount: rows.filter((r) => r.matched).length,
  };
}

export async function commitClaudeSpendImport(
  rows: ClaudePreviewRow[],
  asOf: string,
): Promise<ChatGptCommitResult> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const day = asOf.slice(0, 7) + "-01"; // monthly MTD snapshot, upsert-replace

  const facts: ResolvedFact[] = rows
    .filter((r) => r.usd > 0)
    .map((r) => ({
      source: "claude_team",
      day,
      costType: "overage",
      entityKey: r.email,
      costUsd: r.usd,
      employeeId: r.employeeId,
    }));
  const written = await upsertSpendFacts(supabase, facts);

  const identities = rows
    .filter((r) => r.matched && r.employeeId)
    .map((r) => ({
      vendor: "claude_team" as const,
      external_email: r.email,
      employee_id: r.employeeId,
      match_method: "exact_email" as const,
    }));
  if (identities.length) {
    await supabase.from("identities").upsert(identities, { onConflict: "vendor,external_email" });
  }

  const attributed = facts.filter((f) => f.employeeId).length;
  await supabase.from("imports").insert({
    source: "claude_team",
    kind: "clipboard",
    data_as_of: asOf,
    status: "success",
    row_counts: { withSpend: facts.length, attributed, queued: facts.length - attributed },
  });

  return { written, attributed, queued: facts.length - attributed };
}

// ---- Claude Team roster CSV (seats) ----------------------------------------

export interface RosterPreviewRow {
  name: string;
  email: string;
  seatType: string;
  priceUsd: number;
  employeeId: string | null;
  employeeName: string | null;
  matched: boolean;
}

export interface RosterPreview {
  rows: RosterPreviewRow[];
  errors: { line: number; message: string }[];
  totalUsd: number;
  matchedCount: number;
  byTier: Record<string, number>;
}

/** Parse the roster CSV, match seats to employees by email, price by tier. */
export async function previewClaudeRoster(csv: string): Promise<RosterPreview> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const [{ data: emps }, prices] = await Promise.all([
    supabase.from("employees").select("id, email, full_name"),
    loadSeatPrices(supabase),
  ]);
  const byEmail = new Map((emps ?? []).map((e) => [(e.email as string).toLowerCase(), e]));

  const { seats, errors } = parseClaudeRoster(csv);
  const byTier: Record<string, number> = {};
  const rows: RosterPreviewRow[] = seats.map((s) => {
    const e = byEmail.get(s.email);
    byTier[s.seatType] = (byTier[s.seatType] ?? 0) + 1;
    return {
      name: s.fullName,
      email: s.email,
      seatType: s.seatType,
      priceUsd: prices[`claude_team:${s.seatType}`] ?? 0,
      employeeId: (e?.id as string) ?? null,
      employeeName: (e?.full_name as string) ?? null,
      matched: !!e,
    };
  });

  return {
    rows,
    errors,
    totalUsd: rows.reduce((s, r) => s + r.priceUsd, 0),
    matchedCount: rows.filter((r) => r.matched).length,
    byTier,
  };
}

export async function commitClaudeRoster(
  rows: RosterPreviewRow[],
  asOf: string,
): Promise<{ written: number; seats: number; attributed: number }> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  // Never delete a month when the insert would be empty (gotcha #4).
  if (!rows.length) throw new Error("Nothing to import — the preview has no rows.");
  const day = asOf.slice(0, 7) + "-01";

  // Snapshot semantics: clear this month's Claude seat facts, then re-insert.
  await supabase.from("spend_facts").delete().eq("source", "claude_team").eq("cost_type", "seat").eq("day", day);

  const facts: ResolvedFact[] = rows.map((r) => ({
    source: "claude_team",
    day,
    costType: "seat",
    entityKey: r.email,
    costUsd: r.priceUsd,
    employeeId: r.employeeId,
  }));
  const written = await upsertSpendFacts(supabase, facts);

  // Seat assignments for matched employees.
  const assignments = rows
    .filter((r) => r.employeeId)
    .map((r) => ({
      vendor: "claude_team" as const,
      employee_id: r.employeeId,
      seat_type: r.seatType,
      monthly_price_usd: r.priceUsd,
      period_start: day,
    }));
  if (assignments.length) {
    await supabase.from("seat_assignments").upsert(assignments, { onConflict: "vendor,employee_id,seat_type,period_start" });
  }

  await supabase.from("imports").insert({
    source: "claude_team",
    kind: "csv",
    data_as_of: asOf,
    status: "success",
    row_counts: { seats: rows.length, attributed: assignments.length },
  });

  return { written, seats: rows.length, attributed: assignments.length };
}

// ---- Automated sync: manual trigger + backfill ------------------------------

/** Run all sources now (the cron pipeline, on demand). */
export async function triggerSync(): Promise<Record<string, SyncOutcome>> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const results = await runAllSyncs(supabase, recentWindow(new Date()));
  revalidatePath("/data-health");
  revalidatePath("/");
  return results;
}

export interface BackfillResult {
  months: number;
  written: number;
  errors: string[];
}

/** Backfill the metered API sources over the past N monthly windows. */
export async function backfillSync(months: number): Promise<BackfillResult> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const n = Math.max(1, Math.min(24, Math.floor(months)));
  const now = new Date();
  let written = 0;
  const errors: string[] = [];

  for (let i = 0; i < n; i++) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    const window = { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
    for (const [name, fn] of [
      ["cursor", () => syncCursor(supabase, window)],
      ["anthropic", () => syncAnthropic(supabase, window)],
      ["openai", () => syncOpenAI(supabase, window)],
    ] as const) {
      try {
        written += (await fn()).rowsWritten;
      } catch (err) {
        errors.push(`${window.startDate} ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  revalidatePath("/data-health");
  revalidatePath("/");
  return { months: n, written, errors };
}
