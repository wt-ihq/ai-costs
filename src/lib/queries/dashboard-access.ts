import type { SupabaseClient } from "@supabase/supabase-js";
import { isAccessRole, type AccessRole } from "@/lib/dashboard-access";

/** The dashboard_access list (migrations 0020, 0021). Emails are stored lowercased (normalizeAccessEmail). */
export interface AccessRow { email: string; role: AccessRole; addedBy: string; addedAt: string }

/** One signed-in person's role on the list (null = not listed): the per-request check. Throws when the table can't be read. */
export async function accessRoleOf(supabase: SupabaseClient, email: string): Promise<AccessRole | null> {
  const { data, error } = await supabase.from("dashboard_access").select("role").eq("email", email.trim().toLowerCase()).maybeSingle();
  if (error) throw new Error(`dashboard_access: ${error.message}`);
  if (!data) return null;
  // Anything unexpected in the column grants the least: a viewer.
  return isAccessRole(data.role) ? data.role : "viewer";
}

/** The whole list, paged past PostgREST's 1000-row cap (gotcha #1; email is the primary key, so a unique order). */
export async function fetchAccessList(supabase: SupabaseClient): Promise<AccessRow[]> {
  const PAGE = 1000;
  const out: AccessRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("dashboard_access").select("email, role, added_by, added_at").order("email").range(from, from + PAGE - 1);
    if (error) throw new Error(`dashboard_access: ${error.message}`);
    out.push(...(data ?? []).map((r) => ({
      email: r.email as string,
      role: isAccessRole(r.role) ? r.role : "viewer",
      addedBy: r.added_by as string,
      addedAt: r.added_at as string,
    })));
    if (!data || data.length < PAGE) return out;
  }
}

/** Add someone with a role. Adding someone already listed sets that role and keeps who added them, and when. */
export async function grantAccess(supabase: SupabaseClient, email: string, role: AccessRole, addedBy: string): Promise<void> {
  const { error } = await supabase.from("dashboard_access").insert({ email, role, added_by: addedBy });
  if (!error) return;
  if (error.code !== "23505") throw new Error(`dashboard_access: ${error.message}`);
  await setAccessRole(supabase, email, role);
}

/** Change a listed person's role. Throws when they aren't listed (e.g. removed meanwhile). */
export async function setAccessRole(supabase: SupabaseClient, email: string, role: AccessRole): Promise<void> {
  const { data, error } = await supabase.from("dashboard_access").update({ role }).eq("email", email).select("email");
  if (error) throw new Error(`dashboard_access: ${error.message}`);
  if (!data?.length) throw new Error(`${email} isn't on the access list`);
}

export async function revokeAccess(supabase: SupabaseClient, email: string): Promise<void> {
  const { error } = await supabase.from("dashboard_access").delete().eq("email", email);
  if (error) throw new Error(`dashboard_access: ${error.message}`);
}
