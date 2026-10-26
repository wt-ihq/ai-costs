import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveNotifyMode, type NotifyMode } from "./types";

/**
 * The digest mode chosen on Data → Notifications: one row in notification_config
 * (key 'mode'). Nothing chosen = SLACK_NOTIFY_MODE decides (types.ts:resolveNotifyMode).
 */
const MODE_KEY = "mode";

export async function readStoredMode(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.from("notification_config").select("value").eq("key", MODE_KEY).maybeSingle();
  if (error) throw new Error(`readStoredMode: ${error.message}`);
  return (data?.value as string | undefined) ?? null;
}

export async function writeStoredMode(supabase: SupabaseClient, mode: NotifyMode, updatedBy: string): Promise<void> {
  const { error } = await supabase
    .from("notification_config")
    .upsert({ key: MODE_KEY, value: mode, updated_by: updatedBy, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(`writeStoredMode: ${error.message}`);
}

/** The mode in force right now: stored value where it counts, else the environment variable. */
export async function currentMode(supabase: SupabaseClient): Promise<NotifyMode> {
  return resolveNotifyMode(await readStoredMode(supabase), process.env);
}

/**
 * The first month that gets a monthly recap ("2026-10" = October's figures, sent in November), chosen
 * on Data → Notifications: key 'monthly_from'. Nothing stored (or an empty value) = every month.
 */
const MONTHLY_FROM_KEY = "monthly_from";
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function readMonthlyFrom(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.from("notification_config").select("value").eq("key", MONTHLY_FROM_KEY).maybeSingle();
  if (error) throw new Error(`readMonthlyFrom: ${error.message}`);
  const v = data?.value as string | undefined;
  return v && MONTH_KEY.test(v) ? v : null;
}

export async function writeMonthlyFrom(supabase: SupabaseClient, month: string | null, updatedBy: string): Promise<void> {
  if (month !== null && !MONTH_KEY.test(month)) throw new Error("Not a month (YYYY-MM)");
  const { error } = await supabase
    .from("notification_config")
    .upsert({ key: MONTHLY_FROM_KEY, value: month ?? "", updated_by: updatedBy, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(`writeMonthlyFrom: ${error.message}`);
}
