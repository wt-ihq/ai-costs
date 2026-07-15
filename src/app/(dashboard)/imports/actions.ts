"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { recentWindow, runAllSyncs, type SyncOutcome } from "@/lib/ingest/run-all";
import { syncCursor } from "@/lib/ingest/run-cursor";
import { syncAnthropic, syncOpenAI } from "@/lib/ingest/run-platforms";
import { syncVercel } from "@/lib/ingest/run-vercel";
import { parseClaudeSpend } from "@/lib/ingest/parsers/claude-spend";
import { parseClaudeRoster } from "@/lib/ingest/parsers/claude-roster";
import { parseOpenAiCreditsCsv, coveredWindow, type CreditUsageFact } from "@/lib/ingest/parsers/openai-credits";
import { loadEmployeesFull, upsertSpendFacts, replaceWindowFacts, type ResolvedFact } from "@/lib/ingest/persist";
import { rebuildChatGptSeatMonth, rebuildClaudeSeatMonth } from "@/lib/ingest/seat-months";
import { fetchRecurringEntries, rebuildRecurringFacts, pickColorSlot } from "@/lib/ingest/recurring";
import type { SupabaseClient } from "@supabase/supabase-js";

/** seat_prices as a `${vendor}:${seat_type}` -> USD map. */
async function loadSeatPrices(supabase: SupabaseClient): Promise<Record<string, number>> {
  const { data } = await supabase.from("seat_prices").select("vendor, seat_type, monthly_price_usd");
  return Object.fromEntries((data ?? []).map((p) => [`${p.vendor}:${p.seat_type}`, Number(p.monthly_price_usd)]));
}

export interface ImportCommitResult {
  written: number;
  attributed: number;
  queued: number;
  seats?: number;
}

// ---- ChatGPT monthly seat entries (manual count × price) --------------------

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface SeatEntryInput {
  seatType: string; // 'chatgpt' | 'standard' | 'premium'
  seats: number;
  price: number; // USD for chatgpt_business, £ for claude_team
}

const VALID_TIERS: Record<string, string[]> = {
  chatgpt_business: ["chatgpt"],
  claude_team: ["standard", "premium"],
};

async function rebuildSeatMonth(supabase: SupabaseClient, vendor: string, day: string): Promise<number> {
  return vendor === "claude_team" ? rebuildClaudeSeatMonth(supabase, day) : rebuildChatGptSeatMonth(supabase, day);
}

/** Save a month's authoritative entries (per tier), then rebuild its facts. Claude prices are £ × fxRate. */
export async function saveSeatMonthEntries(
  month: string,
  vendor: "chatgpt_business" | "claude_team",
  inputs: SeatEntryInput[],
  fxRate: number | null,
): Promise<{ written: number }> {
  await requireAdmin();
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month "${month}" — expected YYYY-MM.`);
  if (!inputs.length) throw new Error("Nothing to save — no tier rows.");
  const isClaude = vendor === "claude_team";
  if (isClaude && (!Number.isFinite(fxRate) || (fxRate as number) <= 0)) throw new Error("A £→$ rate > 0 is required for Claude.");
  const supabase = getSupabaseAdminClient();
  const day = `${month}-01`;

  const rows = inputs.map((i) => {
    if (!VALID_TIERS[vendor].includes(i.seatType)) throw new Error(`Invalid tier "${i.seatType}" for ${vendor}.`);
    if (!Number.isInteger(i.seats) || i.seats < 0) throw new Error("Seats must be a whole number ≥ 0.");
    if (!Number.isFinite(i.price) || i.price < 0) throw new Error("Price must be a number ≥ 0.");
    // Round to cents post-conversion: sub-cent prices break cent-exactness.
    const priceUsd = Math.round((isClaude ? i.price * (fxRate as number) : i.price) * 100) / 100;
    return {
      vendor,
      month: day,
      seat_type: i.seatType,
      seats: i.seats,
      price_usd: priceUsd,
      price_gbp: isClaude ? i.price : null,
      fx_rate: isClaude ? fxRate : null,
      updated_at: new Date().toISOString(),
    };
  });

  const { error } = await supabase.from("seat_month_entries").upsert(rows, { onConflict: "vendor,month,seat_type" });
  if (error) throw new Error(`saveSeatMonthEntries: ${error.message}`);

  const written = await rebuildSeatMonth(supabase, vendor, day);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
}

/** Delete one tier's entry for a month and revert its facts to members × default price. */
export async function deleteSeatMonthEntry(
  month: string,
  vendor: "chatgpt_business" | "claude_team",
  seatType: string,
): Promise<{ written: number }> {
  await requireAdmin();
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month "${month}" — expected YYYY-MM.`);
  const supabase = getSupabaseAdminClient();
  const day = `${month}-01`;

  const { error } = await supabase
    .from("seat_month_entries")
    .delete()
    .eq("vendor", vendor)
    .eq("month", day)
    .eq("seat_type", seatType);
  if (error) throw new Error(`deleteSeatMonthEntry: ${error.message}`);

  const written = await rebuildSeatMonth(supabase, vendor, day);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
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
  revalidatePath("/imports");
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
): Promise<ImportCommitResult> {
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

  // Seat assignments for matched employees. Membership itself now comes from
  // the nightly claude_seats sync (Task 4) — this upload only refreshes tiers.
  const assignments = rows
    .filter((r) => r.employeeId)
    .map((r) => ({
      vendor: "claude_team" as const,
      employee_id: r.employeeId,
      seat_type: r.seatType,
      monthly_price_usd: r.priceUsd,
      period_start: day,
    }));

  const matchedEmployeeIds = assignments.map((a) => a.employee_id).filter((id): id is string => !!id);
  if (matchedEmployeeIds.length) {
    // The upsert's conflict target is (vendor, employee_id, seat_type, period_start).
    // If a member's tier changed within the same month, the seat_type differs
    // from their existing row, so the upsert would ADD a second row for the
    // same (employee_id, period_start) instead of replacing the old tier —
    // leaving two rows and making tier resolution ambiguous. Delete exactly
    // the (employee_id, period_start) keys we're about to (re)write first;
    // this is a scoped replace of rows we're rewriting, not a window wipe.
    await supabase
      .from("seat_assignments")
      .delete()
      .eq("vendor", "claude_team")
      .eq("period_start", day)
      .in("employee_id", matchedEmployeeIds);
  }
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

  // Tier changes re-price the month immediately; membership itself comes from
  // the nightly claude_seats sync (entries stay authoritative when present).
  const written = await rebuildClaudeSeatMonth(supabase, day);

  return { written, seats: rows.length, attributed: assignments.length };
}

// ---- Recurring costs for other AI tools -------------------------------------

export interface RecurringCostInput {
  tool: string;
  department: string | null;
  kind: "monthly" | "contract";
  amount: number;
  currency: "USD" | "GBP" | "EUR";
  fxRate: number;
  startMonth: string; // YYYY-MM
  endMonth: string | null;
}

export async function saveRecurringCost(input: RecurringCostInput): Promise<{ written: number }> {
  await requireAdmin();
  const tool = input.tool.trim();
  if (!tool) throw new Error("Tool name is required.");
  if (!MONTH_RE.test(input.startMonth)) throw new Error(`Invalid start month "${input.startMonth}".`);
  if (input.endMonth && !MONTH_RE.test(input.endMonth)) throw new Error(`Invalid end month "${input.endMonth}".`);
  if (input.kind === "contract" && !input.endMonth) throw new Error("Contracts need an end month.");
  if (input.endMonth && input.endMonth < input.startMonth) throw new Error("End month is before start month.");
  if (!Number.isFinite(input.amount) || input.amount < 0) throw new Error("Amount must be a number ≥ 0.");
  const fxRate = input.currency === "USD" ? 1 : input.fxRate;
  if (!Number.isFinite(fxRate) || fxRate <= 0) throw new Error("A conversion rate > 0 is required.");
  const supabase = getSupabaseAdminClient();

  const existing = await fetchRecurringEntries(supabase);
  const colorSlot = pickColorSlot(
    existing.map((e) => ({ tool: e.tool, colorSlot: e.colorSlot })),
    tool,
  );

  const { error } = await supabase.from("recurring_costs").insert({
    tool,
    color_slot: colorSlot,
    department: input.department?.trim() || null,
    kind: input.kind,
    amount: input.amount,
    currency: input.currency,
    fx_rate: fxRate,
    start_month: `${input.startMonth}-01`,
    end_month: input.endMonth ? `${input.endMonth}-01` : null,
  });
  if (error) throw new Error(`saveRecurringCost: ${error.message}`);

  const written = await rebuildRecurringFacts(supabase);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
}

export async function endRecurringCost(id: string, endMonth: string): Promise<{ written: number }> {
  await requireAdmin();
  if (!MONTH_RE.test(endMonth)) throw new Error(`Invalid end month "${endMonth}".`);
  const supabase = getSupabaseAdminClient();

  const { data: rows, error: fetchError } = await supabase
    .from("recurring_costs")
    .select("kind, start_month")
    .eq("id", id)
    .limit(1);
  if (fetchError) throw new Error(`endRecurringCost: ${fetchError.message}`);
  const row = rows?.[0];
  if (!row) throw new Error("Entry not found.");
  if (row.kind === "contract") throw new Error("Contracts can't be ended early — remove and re-add instead.");
  if (`${endMonth}-01` < row.start_month) throw new Error("End month is before the entry's start month.");

  const { error } = await supabase
    .from("recurring_costs")
    .update({ end_month: `${endMonth}-01`, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`endRecurringCost: ${error.message}`);
  const written = await rebuildRecurringFacts(supabase);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
}

export async function deleteRecurringCost(id: string): Promise<{ written: number }> {
  await requireAdmin();
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("recurring_costs").delete().eq("id", id);
  if (error) throw new Error(`deleteRecurringCost: ${error.message}`);
  const written = await rebuildRecurringFacts(supabase);
  revalidatePath("/imports");
  revalidatePath("/");
  return { written };
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
      ["vercel", () => syncVercel(supabase, window)],
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
