import { auth } from "@/auth";

/**
 * Gate every page behind sign-in. The cron route authenticates separately via
 * CRON_SECRET, and the auth routes must stay public.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isPublic =
    pathname.startsWith("/api/auth") || pathname.startsWith("/api/cron");
  if (!req.auth && !isPublic) {
    const url = new URL("/api/auth/signin", req.nextUrl.origin);
    return Response.redirect(url);
  }
});

export const config = {
  // Run on everything except static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg).*)"],
};
