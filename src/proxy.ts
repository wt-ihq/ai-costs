import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";

// Edge-safe NextAuth instance (providers + pure callbacks only — see
// auth.config.ts). Defense in depth: pages and server actions each verify the
// session themselves; this proxy stops unauthenticated traffic at the door.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  if (req.auth) return NextResponse.next();
  // Local-dev-only bypass, mirrored from src/lib/auth-guard.ts.
  if (process.env.AUTH_DISABLED === "true" && process.env.NODE_ENV === "development") {
    return NextResponse.next();
  }
  const signInUrl = new URL("/api/auth/signin", req.nextUrl);
  signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
  return NextResponse.redirect(signInUrl);
});

export const config = {
  // Everything except the auth endpoints, the CRON_SECRET-gated cron routes,
  // Next internals, and static assets.
  matcher: ["/((?!api/auth|api/cron|_next|favicon\\.ico|.*\\.(?:png|svg|ico)$).*)"],
};
