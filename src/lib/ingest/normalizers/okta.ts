import { SchemaDriftError } from "@/lib/ingest/types";

/**
 * Okta is the identity spine (replacing HiBob): everyone is in Okta via SSO.
 * We read the Users API and map each user to an employee row, keyed by email.
 * Team = the Okta user-profile `department` attribute (read directly — no
 * named-list indirection like HiBob needed).
 *
 * ⚠ Shape is per Okta's Users API but should be confirmed against the tenant;
 * the normalizer throws SchemaDriftError if the top-level shape is wrong, and
 * skips individual rows that lack an identity (e.g. service accounts) rather
 * than failing the whole sync.
 */
export interface OktaUser {
  id?: string;
  status?: string; // ACTIVE | PROVISIONED | STAGED | SUSPENDED | DEPROVISIONED | ...
  activated?: string | null; // ISO timestamp
  statusChanged?: string | null; // ISO timestamp
  profile?: {
    firstName?: string;
    lastName?: string;
    displayName?: string;
    email?: string;
    login?: string;
    department?: string;
    [k: string]: unknown;
  };
}
export interface OktaUsersResponse {
  users: OktaUser[];
}

/** Mirrors the employees-table column names; consumed by upsertEmployees. */
export interface EmployeeUpsert {
  okta_id: string;
  email: string;
  full_name: string;
  department: string | null;
  site: string | null;
  employment_status: string | null;
  start_date: string | null;
  leave_date: string | null;
}

// Okta statuses that mean the person has left / lost access. We keep their row
// and stamp leave_date so historical spend stays attributed (never deleted).
const LEAVER_STATUSES = new Set(["DEPROVISIONED", "SUSPENDED"]);

const dateOnly = (ts: string | null | undefined): string | null =>
  typeof ts === "string" && ts.length >= 10 ? ts.slice(0, 10) : null;

export function normalizeOkta(raw: OktaUsersResponse): EmployeeUpsert[] {
  if (!raw || !Array.isArray(raw.users)) {
    throw new SchemaDriftError("okta", "missing `users` array");
  }
  const seen = new Set<string>();
  const out: EmployeeUpsert[] = [];
  for (const u of raw.users) {
    const p = u.profile ?? {};
    const email = (p.email ?? p.login ?? "").toString().toLowerCase();
    if (!u.id || !email) continue; // service/system accounts without an identity — skip, don't fail
    if (seen.has(email)) continue; // first wins; Okta logins are unique but guard anyway
    seen.add(email);

    const status = (u.status ?? "").toUpperCase();
    const isLeaver = LEAVER_STATUSES.has(status);
    const fullName =
      (p.displayName?.toString().trim() ||
        `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim()) ||
      email;

    out.push({
      okta_id: u.id,
      email,
      full_name: fullName,
      department: p.department?.toString().trim() || null,
      site: null, // Okta default profile has no site/office field
      employment_status: status ? status.toLowerCase() : null,
      start_date: dateOnly(u.activated),
      leave_date: isLeaver ? dateOnly(u.statusChanged) : null,
    });
  }
  if (out.length === 0) {
    throw new SchemaDriftError("okta", "no usable users (every row missing id/email)");
  }
  return out;
}
