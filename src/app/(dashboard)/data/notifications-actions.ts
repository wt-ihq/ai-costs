"use server";

import { revalidatePath } from "next/cache";
import { actorEmail, requireAdmin } from "@/lib/auth-guard";
import { parseAdminEmails } from "@/lib/dashboard-access";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchEmployeesAll } from "@/lib/queries/common";
import { addReminderRecipients, addSubscriptions, removeReminderRecipient, removeSubscriptions, setFixedCostSetting, setSubscription } from "@/lib/notify/admin-store";
import { renderChartPng } from "@/lib/notify/chart-image";
import { writeStoredMode } from "@/lib/notify/mode-store";
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

function idsOrThrow(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_BATCH || !input.every(isUuid)) throw new Error("Invalid people selection");
  return input;
}

/** Off / Preview / Live, chosen on Data → Notifications (mode-store.ts). Public POST endpoint: validates the value. */
export async function setNotifyMode(mode: string): Promise<void> {
  await requireAdmin();
  if (mode !== "off" && mode !== "preview" && mode !== "live") throw new Error("Invalid mode");
  await writeStoredMode(getSupabaseAdminClient(), mode, await actorEmail());
  revalidatePath("/data");
}

export async function addRecipients(employeeIds: string[], cadences: string[]): Promise<{ added: number }> {
  await requireAdmin();
  const added = await addSubscriptions(getSupabaseAdminClient(), idsOrThrow(employeeIds), cadencesOrThrow(cadences), await actorEmail());
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

/** Adds people to the company report on these cadences (the report is its own DM, apart from personal digests). */
export async function addCompanyRecipients(employeeIds: string[], cadences: string[]): Promise<{ added: number }> {
  await requireAdmin();
  const added = await addSubscriptions(getSupabaseAdminClient(), idsOrThrow(employeeIds), cadencesOrThrow(cadences), await actorEmail(), "company");
  revalidatePath("/data");
  return { added };
}

export async function setCompanyRecipientCadence(employeeId: string, cadence: string, enabled: boolean): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId) || !isCadence(cadence) || typeof enabled !== "boolean") throw new Error("Invalid input");
  await setSubscription(getSupabaseAdminClient(), employeeId, cadence, enabled, await actorEmail(), "company");
  revalidatePath("/data");
}

export async function removeCompanyRecipient(employeeId: string): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId)) throw new Error("Invalid input");
  await removeSubscriptions(getSupabaseAdminClient(), employeeId, "company");
  revalidatePath("/data");
}

/** Adds someone to the update reminders (Monday 09:30 and the month's last working day). */
export async function addReminderRecipient(employeeId: string): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId)) throw new Error("Invalid input");
  await addReminderRecipients(getSupabaseAdminClient(), [employeeId], await actorEmail());
  revalidatePath("/data");
}

export async function removeReminderRecipientAction(employeeId: string): Promise<void> {
  await requireAdmin();
  if (!isUuid(employeeId)) throw new Error("Invalid input");
  await removeReminderRecipient(getSupabaseAdminClient(), employeeId);
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
        adminEmails: parseAdminEmails(process.env.ADMIN_EMAILS),
      },
      { subject, cadence, periodKey, to },
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
