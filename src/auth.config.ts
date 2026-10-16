import Google from "next-auth/providers/google";
import type { NextAuthConfig } from "next-auth";
import { ALLOWED_DOMAIN, parseAdminEmails } from "@/lib/dashboard-access";

const adminEmails = parseAdminEmails(process.env.ADMIN_EMAILS);

/**
 * Edge-safe auth config (providers + pure callbacks only) — shared by the full
 * server `auth.ts` and the middleware. Keeping NextAuth's server-only pieces
 * out of this module is what lets the middleware run on the Edge runtime
 * (importing the full `@/auth` into middleware fails the deploy).
 *
 * Google SSO, domain-locked to @intenthq.com; admin vs viewer from ADMIN_EMAILS.
 * Signing in is not the same as getting in: a viewer also needs to be on the
 * dashboard access list (auth-guard.ts:requireDashboardAccess).
 */
export const authConfig = {
  providers: [Google],
  callbacks: {
    signIn({ profile }) {
      const email = profile?.email?.toLowerCase() ?? "";
      return profile?.email_verified === true && email.endsWith(`@${ALLOWED_DOMAIN}`);
    },
    // The session's role is ADMIN_EMAILS only. Admins added on Data → Access are resolved on every
    // request instead (auth-guard.ts:getDashboardAccess), so a change applies without signing in again.
    jwt({ token }) {
      const email = (token.email ?? "").toLowerCase();
      token.role = adminEmails.includes(email) ? "admin" : "viewer";
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        (session.user as { role?: string }).role = token.role as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
