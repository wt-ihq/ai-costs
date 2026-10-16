import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { resolveDashboardAccess, type AccessRole } from "@/lib/dashboard-access";
import { accessRoleOf } from "@/lib/queries/dashboard-access";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * AUTH_DISABLED is a local-dev-only bypass. Gating it on NODE_ENV means a
 * stray env var on a deployed environment (e.g. copied into a preview) can
 * never open the dashboard.
 */
function devBypass(): boolean {
  return process.env.AUTH_DISABLED === "true" && process.env.NODE_ENV === "development";
}

/** Current role, or null when signed out: admin from ADMIN_EMAILS or the access list, else viewer. */
export async function getRole(): Promise<string | null> {
  return (await getDashboardAccess())?.role ?? null;
}

/**
 * The signed-in person's role and whether they may open the dashboard (null = signed out).
 * ADMIN_EMAILS admins (the session's role, set at sign-in) are admins always, without a database
 * read; anyone else gets their access-list role, read on every request so a change applies on the
 * next page load. An unreadable list fails closed — ADMIN_EMAILS admins only. Once per request
 * (React cache): the layout, the page and requireAdmin all ask.
 */
export const getDashboardAccess = cache(async (): Promise<{ role: AccessRole; email: string | null; allowed: boolean } | null> => {
  if (devBypass()) return { role: "admin", email: null, allowed: true };
  const session = await auth().catch(() => null);
  if (!session?.user) return null;
  const email = session.user.email?.toLowerCase() ?? null;
  if ((session.user as { role?: string }).role === "admin") return { role: "admin", email, allowed: true };
  let listed: AccessRole | null = null;
  if (email) {
    try {
      listed = await accessRoleOf(getSupabaseAdminClient(), email);
    } catch (err) {
      console.error(`[access] list unreadable, ADMIN_EMAILS admins only: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ...resolveDashboardAccess({ envAdmin: false, listed }), email };
});

/**
 * The dashboard's gate: signed out → sign-in; signed in without access → /no-access.
 * EVERY dashboard page calls this before loading data, not just the layout: a
 * layout doesn't re-run on in-app navigation, so it can't guard a page alone
 * (pages.test.ts checks each page does).
 */
export async function requireDashboardAccess(): Promise<string> {
  const access = await getDashboardAccess();
  if (!access) redirect("/api/auth/signin");
  if (!access.allowed) redirect("/no-access");
  return access.role;
}

/**
 * Mutation gate for server actions ("use server" exports are public POST
 * endpoints — the dashboard layout's redirect does NOT run for action
 * invocations, so every action must check the session itself).
 */
export async function requireAdmin(): Promise<void> {
  const role = await getRole();
  if (role !== "admin") throw new Error("Unauthorized: admin role required");
}

/** The signed-in admin's email, for "added by" columns (dev bypass has no session: fall back to SLACK_PREVIEW_EMAIL in development only). */
export async function actorEmail(): Promise<string> {
  const session = await auth().catch(() => null);
  const email = session?.user?.email?.toLowerCase();
  if (email) return email;
  if (process.env.NODE_ENV === "development" && process.env.SLACK_PREVIEW_EMAIL) return process.env.SLACK_PREVIEW_EMAIL.toLowerCase();
  throw new Error("No signed-in email");
}
