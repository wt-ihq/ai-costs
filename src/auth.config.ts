import Google from "next-auth/providers/google";
import type { NextAuthConfig } from "next-auth";

const ALLOWED_DOMAIN = "intenthq.com";

const adminEmails = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * Edge-safe auth config (providers + pure callbacks only) — shared by the full
 * server `auth.ts` and the middleware. Keeping NextAuth's server-only pieces
 * out of this module is what lets the middleware run on the Edge runtime
 * (importing the full `@/auth` into middleware fails the deploy).
 *
 * Google SSO, domain-locked to @intenthq.com; admin vs viewer from ADMIN_EMAILS.
 */
export const authConfig = {
  providers: [Google],
  callbacks: {
    signIn({ profile }) {
      const email = profile?.email?.toLowerCase() ?? "";
      return email.endsWith(`@${ALLOWED_DOMAIN}`);
    },
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
