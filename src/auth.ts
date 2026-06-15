import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const ALLOWED_DOMAIN = "intenthq.com";

/**
 * Auth.js (v5) — Google SSO, domain-locked to @intenthq.com (spec §4).
 * Two roles: `admin` (imports, identity fixes, sync triggers) and `viewer`.
 * Admin emails come from the ADMIN_EMAILS env var (comma-separated).
 */
const adminEmails = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const { handlers, auth, signIn, signOut } = NextAuth({
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
});
