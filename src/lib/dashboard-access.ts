/**
 * Who may open the dashboard: admins (ADMIN_EMAILS) always; anyone else only
 * when an admin has put them on the dashboard_access list (Data → Access), as a
 * viewer or as an admin.
 * Shared by the page gate (auth-guard.ts) and the Slack digests, which show
 * dashboard links only to people who can follow them. Pure — safe for the
 * Edge auth config and client code.
 */

/** Sign-in is domain-locked to this (auth.config.ts). */
export const ALLOWED_DOMAIN = "intenthq.com";

export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** A role on the access list (migration 0021). ADMIN_EMAILS admins aren't on it: they're admins regardless. */
export type AccessRole = "viewer" | "admin";
export const ACCESS_ROLES: readonly AccessRole[] = ["viewer", "admin"];

export function isAccessRole(v: unknown): v is AccessRole {
  return typeof v === "string" && (ACCESS_ROLES as readonly string[]).includes(v);
}

/**
 * A signed-in person's standing. `envAdmin`: in ADMIN_EMAILS (the session's role, set at sign-in).
 * `listed`: their access-list role — null when not listed OR the list couldn't be read, so an outage
 * fails closed to the ADMIN_EMAILS admins only.
 */
export function resolveDashboardAccess(v: { envAdmin: boolean; listed: AccessRole | null }): { role: AccessRole; allowed: boolean } {
  if (v.envAdmin) return { role: "admin", allowed: true };
  if (v.listed) return { role: v.listed, allowed: true };
  return { role: "viewer", allowed: false };
}

/** `allowlist` null = it couldn't be read: fail closed, admins only. */
export function canAccessDashboard(v: { isAdmin: boolean; email: string | null | undefined; allowlist: ReadonlySet<string> | null }): boolean {
  if (v.isAdmin) return true;
  const email = v.email?.trim().toLowerCase();
  return !!email && !!v.allowlist?.has(email);
}

/** The same rule keyed by email alone, for people who aren't signed in (digest recipients). */
export function dashboardAccessFor(adminEmails: readonly string[], allowlist: ReadonlySet<string> | null): (email: string) => boolean {
  const admins = new Set(adminEmails.map((e) => e.toLowerCase()));
  return (email) => canAccessDashboard({ isAdmin: admins.has(email.trim().toLowerCase()), email, allowlist });
}

const LOCAL_PART = /^[a-z0-9._%+'-]+$/;

/** An address an admin typed, as stored: trimmed, lowercased, and one that can actually sign in. Null otherwise. */
export function normalizeAccessEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  const [local, domain, ...rest] = email.split("@");
  if (rest.length || domain !== ALLOWED_DOMAIN || !local || !LOCAL_PART.test(local)) return null;
  return email;
}
