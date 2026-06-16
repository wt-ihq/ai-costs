import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge-safe gate: a fast session-cookie presence check that redirects
 * signed-out visitors to sign-in. This imports NO auth library, so it bundles
 * cleanly for the Edge runtime. It is only a UX redirect — the authoritative
 * check (real session verification + role) happens in the dashboard layout
 * (a Node server component), which every page nests under. The cron route uses
 * CRON_SECRET; the auth routes must stay public.
 */
export default function middleware(req: NextRequest) {
  if (process.env.AUTH_DISABLED === "true") return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/auth") || pathname.startsWith("/api/cron")) {
    return NextResponse.next();
  }

  const hasSession =
    req.cookies.has("authjs.session-token") ||
    req.cookies.has("__Secure-authjs.session-token");
  if (!hasSession) {
    return NextResponse.redirect(new URL("/api/auth/signin", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg).*)"],
};
