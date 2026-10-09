import { NextResponse } from "next/server";
import { getRole } from "@/lib/auth-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { openRedirectPath } from "@/lib/notify/opens";
import { supabaseNotifyStore } from "@/lib/notify/store";

export const dynamic = "force-dynamic";

/**
 * A Slack digest's "Open in dashboard" button: stamp the send's first open, then
 * redirect to the recipient's Explore page. Behind the sign-in proxy like any
 * page, and it checks the session itself too (defence in depth). The send id is
 * in the PATH because sign-in returns to the path only. Recording never blocks the click.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getRole())) {
    const signIn = new URL("/api/auth/signin", req.url);
    signIn.searchParams.set("callbackUrl", new URL(req.url).pathname);
    return NextResponse.redirect(signIn);
  }
  const { id } = await params;
  let path = "/explore";
  try {
    path = await openRedirectPath(supabaseNotifyStore(getSupabaseAdminClient()), id);
  } catch (err) {
    console.error(`[notify] open not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
  return NextResponse.redirect(new URL(path, req.url));
}
