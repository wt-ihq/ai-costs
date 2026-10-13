"use server";

import { revalidatePath } from "next/cache";
import { actorEmail, requireAdmin } from "@/lib/auth-guard";
import { normalizeAccessEmail } from "@/lib/dashboard-access";
import { grantAccess, revokeAccess } from "@/lib/queries/dashboard-access";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const emailOrThrow = (input: unknown): string => {
  const email = normalizeAccessEmail(input);
  if (!email) throw new Error("Enter an @intenthq.com email address");
  return email;
};

/** Let someone open the dashboard. Takes effect on their next page load. */
export async function grantDashboardAccess(email: unknown): Promise<void> {
  await requireAdmin();
  await grantAccess(getSupabaseAdminClient(), emailOrThrow(email), await actorEmail());
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
