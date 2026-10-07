"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { requireAdmin } from "@/lib/auth-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { addSubscriptions, removeSubscriptions, setFixedCostSetting, setSubscription } from "@/lib/notify/admin-store";
import { renderChartPng } from "@/lib/notify/chart-image";
import type { TestSubject, TestTarget } from "@/lib/notify/subject";
import { supabaseNotifyStore } from "@/lib/notify/store";
import { sendTest, type TestSendResult } from "@/lib/notify/test-send";
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

const isIncludeChoice = (v: unknown): v is boolean | null => v === null || typeof v === "boolean";

/** The organisation default for counting seats & subscriptions in digests. */
export async function setOrgFixedCosts(include: boolean): Promise<void> {
  await requireAdmin();
  if (typeof include !== "boolean") throw new Error("Invalid input");
  await setFixedCostSetting(getSupabaseAdminClient(), "org", "", include, await actorEmail());
  revalidatePath("/data");
}

/** A team's override; null removes it (the team follows the organisation default). */
export async function setTeamFixedCosts(department: string, include: boolean | null): Promise<void> {
  await requireAdmin();
  if (typeof department !== "string" || !department.trim() || department.length > 200 || !isIncludeChoice(include)) throw new Error("Invalid input");
  await setFixedCostSetting(getSupabaseAdminClient(), "department", department, include, await actorEmail());
  revalidatePath("/data");
}

/** A person's override; null removes it (they follow their team, else the default). */
export async function setPersonFixedCosts(employeeId: string, include: boolean | null): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId) || !isIncludeChoice(include)) throw new Error("Invalid input");
  await setFixedCostSetting(getSupabaseAdminClient(), "employee", employeeId, include, await actorEmail());
  revalidatePath("/data");
}

/**
 * Admin test send: any person's or any team's digest, DM'd to the signed-in admin, to the person
 * themself, or to any chosen active employee — clearly marked as a test, in ANY SLACK_NOTIFY_MODE,
 * and never recorded in notification_sends (so it can't block or duplicate the scheduled send).
 * Public POST endpoint: sendTest re-validates every argument.
 */
export async function sendTestDigest(subject: TestSubject, cadence: string, periodKey: string, to: TestTarget): Promise<TestSendResult> {
  await requireAdmin();
  try {
    return await sendTest(
      {
        store: supabaseNotifyStore(getSupabaseAdminClient()),
        slack: slackClientFromEnv(),
        renderChart: renderChartPng,
        now: new Date(),
        baseUrl: appBaseUrl(),
        actorEmail: await actorEmail(),
      },
      { subject, cadence, periodKey, to },
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
