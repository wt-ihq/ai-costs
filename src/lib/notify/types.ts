/** Shared types for Slack spend digests (spec: docs/superpowers/specs/2026-09-30-slack-spend-digests-design.md). */

export type Cadence = "daily" | "weekly" | "monthly";
export const CADENCES: readonly Cadence[] = ["daily", "weekly", "monthly"];

/** off = nothing sent; preview = every DM goes to SLACK_PREVIEW_EMAIL; live = DMs go to recipients. */
export type NotifyMode = "off" | "preview" | "live";
export type SendMode = Exclude<NotifyMode, "off">;

/** Fails safe: anything but an explicit preview/live is off. */
export function notifyMode(env: Record<string, string | undefined> = process.env): NotifyMode {
  const m = env.SLACK_NOTIFY_MODE?.trim().toLowerCase();
  return m === "preview" || m === "live" ? m : "off";
}

export function isCadence(v: unknown): v is Cadence {
  return typeof v === "string" && (CADENCES as readonly string[]).includes(v);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export interface NotifyEmployee {
  id: string;
  email: string; // lowercased
  fullName: string;
  department: string | null;
  oktaId: string | null;
  employeeNumber: string | null;
  managerRef: string | null;
  employmentStatus: string | null;
  leaveDate: string | null;
}

export const NOTIFY_EMPLOYEE_COLUMNS =
  "id, email, full_name, department, okta_id, employee_number, manager_ref, employment_status, leave_date";

const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

export function toNotifyEmployee(r: Record<string, unknown>): NotifyEmployee {
  return {
    id: r.id as string,
    email: ((r.email as string) ?? "").toLowerCase(),
    fullName: str(r.full_name) ?? ((r.email as string) ?? "Unknown"),
    department: str(r.department),
    oktaId: str(r.okta_id),
    employeeNumber: str(r.employee_number),
    managerRef: str(r.manager_ref),
    employmentStatus: str(r.employment_status),
    leaveDate: str(r.leave_date),
  };
}

// Okta leaver statuses (normalizers/okta.ts) plus the legacy HiBob "leaver".
const LEFT = new Set(["deprovisioned", "suspended", "leaver"]);

/** Recipients and headcounts use active people only; leavers' past spend still rolls up. */
export function isActiveEmployee(e: Pick<NotifyEmployee, "employmentStatus" | "leaveDate">): boolean {
  return e.leaveDate === null && !LEFT.has((e.employmentStatus ?? "").toLowerCase());
}
