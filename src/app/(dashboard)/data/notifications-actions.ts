"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { addSubscriptions, removeSubscriptions, setSubscription } from "@/lib/notify/admin-store";
import { renderChartPng } from "@/lib/notify/chart-image";
import { digestFor, loadNotifyContext } from "@/lib/notify/context";
import { deliverDigest, resolveSlackUser } from "@/lib/notify/deliver";
import { periodFor } from "@/lib/notify/schedule";
import { supabaseNotifyStore } from "@/lib/notify/store";
import { isActiveEmployee, isCadence, isUuid, NOTIFY_EMPLOYEE_COLUMNS, toNotifyEmployee, type Cadence } from "@/lib/notify/types";
import { appBaseUrl, slackClientFromEnv } from "@/lib/notify/wiring";

const MAX_BATCH = 500;

function cadencesOrThrow(input: unknown): Cadence[] {
  if (!Array.isArray(input) || input.length === 0 || !input.every(isCadence)) throw new Error("Pick at least one valid cadence");
  return [...new Set(input)];
}

/** The signed-in admin's email (dev bypass has no session: fall back to SLACK_PREVIEW_EMAIL in development only). */
async function actorEmail(): Promise<string> {
  const session = await auth().catch(() => null);
  const email = session?.user?.email?.toLowerCase();
  if (email) return email;
  if (process.env.NODE_ENV === "development" && process.env.SLACK_PREVIEW_EMAIL) return process.env.SLACK_PREVIEW_EMAIL.toLowerCase();
  throw new Error("No signed-in email");
}

export async function addRecipients(employeeIds: string[], cadences: string[]): Promise<{ added: number }> {
  await requireAdmin();
  if (!Array.isArray(employeeIds) || !employeeIds.length || employeeIds.length > MAX_BATCH || !employeeIds.every(isUuid)) {
    throw new Error("Invalid people selection");
  }
  const added = await addSubscriptions(getSupabaseAdminClient(), employeeIds, cadencesOrThrow(cadences), await actorEmail());
  revalidatePath("/data");
  return { added };
}

/** Enrols a team's CURRENT active members once; later joiners are not auto-enrolled. */
export async function addTeamRecipients(department: string, cadences: string[]): Promise<{ added: number }> {
  await requireAdmin();
  if (typeof department !== "string" || !department.trim()) throw new Error("Pick a team");
  const supabase = getSupabaseAdminClient();
  const members = (await fetchEmployeesAll(supabase, NOTIFY_EMPLOYEE_COLUMNS, { department })).map(toNotifyEmployee).filter(isActiveEmployee);
  if (!members.length) throw new Error(`No active people in ${department}`);
  if (members.length > MAX_BATCH) throw new Error("Team too large to add at once");
  const added = await addSubscriptions(supabase, members.map((m) => m.id), cadencesOrThrow(cadences), await actorEmail());
  revalidatePath("/data");
  return { added };
}

export async function setRecipientCadence(employeeId: string, cadence: string, enabled: boolean): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId) || !isCadence(cadence) || typeof enabled !== "boolean") throw new Error("Invalid input");
  await setSubscription(getSupabaseAdminClient(), employeeId, cadence, enabled, await actorEmail());
  revalidatePath("/data");
}

export async function removeRecipient(employeeId: string): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId)) throw new Error("Invalid input");
  await removeSubscriptions(getSupabaseAdminClient(), employeeId);
  revalidatePath("/data");
}

/** DMs the previewed digest to the SIGNED-IN admin only. Never logged as a send, never sent to the recipient. */
export async function sendPreviewToMe(employeeId: string, cadence: string, periodKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireAdmin();
  if (!isUuid(employeeId) || !isCadence(cadence) || typeof periodKey !== "string") return { ok: false, error: "Invalid input" };
  try {
    const now = new Date();
    const period = periodFor(cadence, periodKey, now);
    const store = supabaseNotifyStore(getSupabaseAdminClient());
    const ctx = await loadNotifyContext(store, now, appBaseUrl(), { earliest: period.buckets[0].from });
    const digest = digestFor(ctx, employeeId, period);
    if (!digest) return { ok: false, error: "Nothing to send for that period (no usage)" };
    const email = await actorEmail();
    const me = ctx.employees.find((e) => e.email === email);
    if (!me) return { ok: false, error: "Your email isn't in the employee list" };
    const slack = slackClientFromEnv();
    const slackUserId = await resolveSlackUser(store, slack, me, now);
    if (!slackUserId) return { ok: false, error: "No Slack account found for your email" };
    await deliverDigest({ slack, renderChart: renderChartPng, slackUserId, digest, previewFor: `${digest.recipient.name} (${cadence})` });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
