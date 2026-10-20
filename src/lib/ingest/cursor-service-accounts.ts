import type { SupabaseClient } from "@supabase/supabase-js";
import { CURSOR_SERVICE_ACCOUNT } from "@/lib/pseudo-entities";
import type { ResolvedFact } from "./persist";

/**
 * Cursor service accounts (automations with no user email — Bugbot, background agents, the CLI in
 * CI) are person-less. An admin can name one and give it a team on Data → Tools
 * (`cursor_service_accounts`, migration 0025): its spend then counts toward that team, still not
 * tied to a person. New accounts are registered by the nightly sync; one whose usage is all
 * Cursor's code-review model is pre-named "Bugbot".
 */
export interface ServiceAccountSetting {
  label: string | null;
  department: string | null;
}

const PREFIX = `${CURSOR_SERVICE_ACCOUNT} `;

/** "cursor service account sa_…" → "sa_…"; null for anything else (incl. an unknown id). */
export function serviceAccountIdOf(entityKey: string): string | null {
  if (!entityKey.startsWith(PREFIX)) return null;
  const id = entityKey.slice(PREFIX.length).trim();
  return id && !id.startsWith("(") ? id : null;
}

/** The entity key of a service account id (normalizers/cursor.ts builds the same). */
export const serviceAccountEntity = (id: string) => `${PREFIX}${id}`;

/** "Bugbot" when every event is Cursor's code-review model (`github_bugbot`), else no suggestion. */
export function suggestedLabel(models: string[]): string | null {
  return models.length > 0 && models.every((m) => m === "github_bugbot") ? "Bugbot" : null;
}

/** A mapped service account's facts carry its team; people and unmapped accounts are untouched. Pure. */
export function applyServiceAccountTeams(facts: ResolvedFact[], teamById: ReadonlyMap<string, string>): ResolvedFact[] {
  return facts.map((f) => {
    if (f.employeeId) return f;
    const id = serviceAccountIdOf(f.entityKey);
    const team = id ? teamById.get(id) : undefined;
    return team ? { ...f, department: team } : f;
  });
}

/** How a service account shows in admin lists: "Bugbot (Cursor service account sa_6088564e…)". */
export function serviceAccountLabel(entityKey: string, labelById: ReadonlyMap<string, string>): string {
  const id = serviceAccountIdOf(entityKey);
  const label = id ? labelById.get(id) : undefined;
  return label ? `${label} (Cursor service account ${id!.slice(0, 11)}…)` : entityKey;
}

/** A Data → Tools save, checked: the account id, and a name and team (blank = unset). */
export function cleanServiceAccountInput(accountId: unknown, label: unknown, department: unknown): { accountId: string; label: string | null; department: string | null } {
  if (typeof accountId !== "string" || !/^sa_[\w-]{1,80}$/.test(accountId)) throw new Error("Invalid service account");
  const text = (v: unknown, max: number, what: string): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") throw new Error(`Invalid ${what}`);
    const t = v.trim();
    if (t.length > max) throw new Error(`${what === "name" ? "Name" : "Team"} is too long`);
    return t || null;
  };
  return { accountId, label: text(label, 60, "name"), department: text(department, 200, "team") };
}

/** What the Cursor sync needs from the settings: each named account's team, and a way to register new ones. */
export interface ServiceAccountRegistry {
  teams(): ReadonlyMap<string, string>;
  register(facts: ResolvedFact[]): Promise<void>;
}

/** The registry backed by `cursor_service_accounts`, read once per sync. */
export async function serviceAccountRegistry(supabase: SupabaseClient): Promise<ServiceAccountRegistry> {
  const known = await loadServiceAccounts(supabase);
  return {
    teams: () => new Map([...known].flatMap(([id, s]) => (s.department ? [[id, s.department] as const] : []))),
    register: (facts) => registerServiceAccounts(supabase, facts, known),
  };
}

/** Every service-account setting (bounded: the table grows by accounts, not days). */
export async function loadServiceAccounts(supabase: SupabaseClient): Promise<Map<string, ServiceAccountSetting>> {
  const { data, error } = await supabase.from("cursor_service_accounts").select("account_id, label, department").limit(500);
  if (error) throw new Error(`cursor_service_accounts: ${error.message}`);
  return new Map((data ?? []).map((r) => [r.account_id as string, { label: (r.label as string) ?? null, department: (r.department as string) ?? null }]));
}

/**
 * Register service accounts first seen in these facts (label suggested from their models; no team),
 * and add them to `known`. Existing rows are never touched, so admin settings stand.
 */
export async function registerServiceAccounts(supabase: SupabaseClient, facts: ResolvedFact[], known: Map<string, ServiceAccountSetting>): Promise<void> {
  const models = new Map<string, string[]>();
  for (const f of facts) {
    const id = serviceAccountIdOf(f.entityKey);
    if (id && !known.has(id)) models.set(id, [...(models.get(id) ?? []), f.model ?? ""]);
  }
  if (!models.size) return;
  const rows = [...models].map(([id, m]) => ({ account_id: id, label: suggestedLabel(m), department: null, updated_by: "cursor sync" }));
  const { error } = await supabase.from("cursor_service_accounts").upsert(rows, { onConflict: "account_id", ignoreDuplicates: true });
  if (error) throw new Error(`cursor_service_accounts register: ${error.message}`);
  for (const r of rows) known.set(r.account_id, { label: r.label, department: null });
}
