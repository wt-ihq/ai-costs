"use server";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { parseChatGptMemberTable, normalizeName } from "@/lib/ingest/parsers/chatgpt-clipboard";
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
