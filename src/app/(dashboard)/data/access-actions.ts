"use server";

import { revalidatePath } from "next/cache";
import { actorEmail, requireAdmin } from "@/lib/auth-guard";
import { isAccessRole, normalizeAccessEmail, type AccessRole } from "@/lib/dashboard-access";
import { grantAccess, revokeAccess, setAccessRole } from "@/lib/queries/dashboard-access";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const emailOrThrow = (input: unknown): string => {
  const email = normalizeAccessEmail(input);
  if (!email) throw new Error("Enter an @intenthq.com email address");
  return email;
};

const roleOrThrow = (input: unknown): AccessRole => {
  if (!isAccessRole(input)) throw new Error("Pick Viewer or Admin");
  return input;
};

/** Let someone open the dashboard, as a viewer or an admin. Takes effect on their next page load. */
export async function grantDashboardAccess(email: unknown, role: unknown): Promise<void> {
  await requireAdmin();
  await grantAccess(getSupabaseAdminClient(), emailOrThrow(email), roleOrThrow(role), await actorEmail());
  revalidatePath("/data");
}

/**
 * Make a listed person a viewer or an admin. An admin made here can do everything (including this);
 * ADMIN_EMAILS admins aren't on the list, so they can't be demoted from the page.
 */
export async function setDashboardAccessRole(email: unknown, role: unknown): Promise<void> {
  await requireAdmin();
  if (typeof email !== "string" || !email.trim()) throw new Error("Invalid email");
  await setAccessRole(getSupabaseAdminClient(), email.trim().toLowerCase(), roleOrThrow(role));
  revalidatePath("/data");
}

/**
 * Take it away again: their next page load shows "no access", even mid-session. Any listed address can
 * be removed, including one that wouldn't pass the add check (e.g. put in by hand in the database).
 */
export async function revokeDashboardAccess(email: unknown): Promise<void> {
  await requireAdmin();
  if (typeof email !== "string" || !email.trim()) throw new Error("Invalid email");
  await revokeAccess(getSupabaseAdminClient(), email.trim().toLowerCase());
  revalidatePath("/data");
}
