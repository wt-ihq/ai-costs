import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

/**
 * AUTH_DISABLED is a local-dev-only bypass. Gating it on NODE_ENV means a
 * stray env var on a deployed environment (e.g. copied into a preview) can
 * never open the dashboard.
 */
function devBypass(): boolean {
  return process.env.AUTH_DISABLED === "true" && process.env.NODE_ENV === "development";
}

/** Current role, or null when signed out. */
export async function getRole(): Promise<string | null> {
  if (devBypass()) return "admin";
  const session = await auth().catch(() => null);
  if (!session?.user) return null;
  return (session.user as { role?: string }).role ?? "viewer";
}

/** Page gate: redirects signed-out users to sign-in. */
export async function requireRole(): Promise<string> {
  const role = await getRole();
  if (!role) redirect("/api/auth/signin");
  return role;
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
