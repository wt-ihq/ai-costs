"use server";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { parseChatGptMemberTable, normalizeName } from "@/lib/ingest/parsers/chatgpt-clipboard";
import { parseClaudeSpend } from "@/lib/ingest/parsers/claude-spend";
import { parseClaudeRoster } from "@/lib/ingest/parsers/claude-roster";
import { matchByName } from "@/lib/ingest/identity";
import { loadEmployeeNames, upsertSpendFacts, type ResolvedFact } from "@/lib/ingest/persist";
import type { SupabaseClient } from "@supabase/supabase-js";

/** seat_prices as a `${vendor}:${seat_type}` -> USD map. */
async function loadSeatPrices(supabase: SupabaseClient): Promise<Record<string, number>> {
  const { data } = await supabase.from("seat_prices").select("vendor, seat_type, monthly_price_usd");
  return Object.fromEntries((data ?? []).map((p) => [`${p.vendor}:${p.seat_type}`, Number(p.monthly_price_usd)]));
}

export interface ChatGptPreviewRow {
  name: string;
  creditsSpent: number;
  usd: number;
  employeeId: string | null;
  employeeName: string | null;
  confidence: "high" | "low" | "none";
}

export interface ChatGptPreview {
  rows: ChatGptPreviewRow[];
  errors: { line: number; message: string }[];
  totalUsd: number;
}

/** Parse the pasted member table and fuzzy-match each member to an employee. */
export async function previewChatGptImport(
  text: string,
  usdPerCredit: number,
): Promise<ChatGptPreview> {
  const supabase = getSupabaseAdminClient();
  const employees = await loadEmployeeNames(supabase);
  const byId = new Map(employees.map((e) => [e.id, e.fullName]));

  const { members, errors } = parseChatGptMemberTable(text, new Date().toISOString().slice(0, 10), usdPerCredit);

  const rows: ChatGptPreviewRow[] = members.map((m) => {
    const match = matchByName(m.name, employees);
    return {
      name: m.name,
      creditsSpent: m.creditsSpent,
      usd: Math.round(m.creditsSpent * usdPerCredit * 100) / 100,
      employeeId: match.confidence === "high" ? match.employeeId : null,
      employeeName: match.employeeId ? byId.get(match.employeeId) ?? null : null,
      confidence: match.confidence,
    };
  });

  return { rows, errors, totalUsd: rows.reduce((s, r) => s + r.usd, 0) };
}

export interface ChatGptCommitResult {
  written: number;
  attributed: number;
  queued: number;
  seats?: number;
}

/** Commit reviewed rows: upsert overage facts, identities, and an import log. */
export async function commitChatGptImport(
  rows: ChatGptPreviewRow[],
  asOf: string,
): Promise<ChatGptCommitResult> {
  const supabase = getSupabaseAdminClient();
  const day = asOf.slice(0, 7) + "-01"; // monthly snapshot, upsert-replace
  const seatPrice = (await loadSeatPrices(supabase))["chatgpt_business:chatgpt"] ?? 25;

  // Snapshot semantics: clear this month's ChatGPT facts, then re-insert.
  await supabase.from("spend_facts").delete().eq("source", "chatgpt_business").eq("day", day);

  const withSpend = rows.filter((r) => r.usd > 0);
  const empId = (r: ChatGptPreviewRow) => (r.confidence === "high" ? r.employeeId : null);

  // Every listed member holds a seat; members with credits also incur overage.
  const seatFacts: ResolvedFact[] = rows.map((r) => ({
    source: "chatgpt_business",
    day,
    costType: "seat",
    entityKey: normalizeName(r.name),
    costUsd: seatPrice,
    employeeId: empId(r),
  }));
  const overageFacts: ResolvedFact[] = withSpend.map((r) => ({
    source: "chatgpt_business",
    day,
    costType: "overage",
    entityKey: normalizeName(r.name),
    costUsd: r.usd,
    employeeId: empId(r),
  }));

  const written = await upsertSpendFacts(supabase, [...seatFacts, ...overageFacts]);

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

  const attributed = overageFacts.filter((f) => f.employeeId).length;
  await supabase.from("imports").insert({
    source: "chatgpt_business",
    kind: "clipboard",
    data_as_of: asOf,
    status: "success",
    row_counts: { members: rows.length, seats: rows.length, withSpend: withSpend.length, attributed, queued: withSpend.length - attributed },
  });

  return { written, attributed, queued: withSpend.length - attributed, seats: rows.length };
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
  const supabase = getSupabaseAdminClient();
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
