import type { SupabaseClient } from "@supabase/supabase-js";

/** The dashboard_access list (migration 0020). Emails are stored lowercased (normalizeAccessEmail). */
export interface AccessRow { email: string; addedBy: string; addedAt: string }

/** One signed-in person's entry: the page gate's per-request check. Throws when the table can't be read. */
export async function isOnAccessList(supabase: SupabaseClient, email: string): Promise<boolean> {
  const { data, error } = await supabase.from("dashboard_access").select("email").eq("email", email.trim().toLowerCase()).maybeSingle();
  if (error) throw new Error(`dashboard_access: ${error.message}`);
  return data !== null;
}

/** The whole list, paged past PostgREST's 1000-row cap (gotcha #1; email is the primary key, so a unique order). */
export async function fetchAccessList(supabase: SupabaseClient): Promise<AccessRow[]> {
  const PAGE = 1000;
  const out: AccessRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("dashboard_access").select("email, added_by, added_at").order("email").range(from, from + PAGE - 1);
    if (error) throw new Error(`dashboard_access: ${error.message}`);
    out.push(...(data ?? []).map((r) => ({ email: r.email as string, addedBy: r.added_by as string, addedAt: r.added_at as string })));
    if (!data || data.length < PAGE) return out;
  }
}

/** Adding someone already listed keeps their original entry. */
export async function grantAccess(supabase: SupabaseClient, email: string, addedBy: string): Promise<void> {
  const { error } = await supabase.from("dashboard_access").upsert({ email, added_by: addedBy }, { onConflict: "email", ignoreDuplicates: true });
  if (error) throw new Error(`dashboard_access: ${error.message}`);
}

export async function revokeAccess(supabase: SupabaseClient, email: string): Promise<void> {
  const { error } = await supabase.from("dashboard_access").delete().eq("email", email);
  if (error) throw new Error(`dashboard_access: ${error.message}`);
}
