"use server";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { parseChatGptMemberTable, normalizeName } from "@/lib/ingest/parsers/chatgpt-clipboard";
import { parseClaudeSpend } from "@/lib/ingest/parsers/claude-spend";
import { matchByName } from "@/lib/ingest/identity";
import { loadEmployeeNames, upsertSpendFacts, type ResolvedFact } from "@/lib/ingest/persist";

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
}

/** Commit reviewed rows: upsert overage facts, identities, and an import log. */
export async function commitChatGptImport(
  rows: ChatGptPreviewRow[],
  asOf: string,
): Promise<ChatGptCommitResult> {
  const supabase = getSupabaseAdminClient();
  const day = asOf.slice(0, 7) + "-01"; // monthly snapshot, upsert-replace

  const withSpend = rows.filter((r) => r.usd > 0);
  const facts: ResolvedFact[] = withSpend.map((r) => ({
    source: "chatgpt_business",
    day,
    costType: "overage",
    entityKey: normalizeName(r.name),
    costUsd: r.usd,
    employeeId: r.confidence === "high" ? r.employeeId : null,
  }));

  const written = await upsertSpendFacts(supabase, facts);

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

  const attributed = facts.filter((f) => f.employeeId).length;
  await supabase.from("imports").insert({
    source: "chatgpt_business",
    kind: "clipboard",
    data_as_of: asOf,
    status: "success",
    row_counts: { members: rows.length, withSpend: withSpend.length, attributed, queued: withSpend.length - attributed },
  });

  return { written, attributed, queued: withSpend.length - attributed };
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
