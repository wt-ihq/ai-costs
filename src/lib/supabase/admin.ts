import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client for the cron sync and admin imports ONLY.
 * Bypasses RLS — never import this into client or unauthenticated code paths.
 * The service-role key lives in Vercel env vars, never in the browser.
 */
export function getSupabaseAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
