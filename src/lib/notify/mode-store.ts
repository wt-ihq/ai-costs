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
