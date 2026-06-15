import { SchemaDriftError } from "@/lib/ingest/types";

/** Employee upsert shape (snake_case matches the employees table). */
export interface EmployeeUpsert {
  hibob_id: string;
  email: string;
  full_name: string;
  department: string | null;
  site: string | null;
  employment_status: string | null;
  start_date: string | null;
  leave_date: string | null;
}

/**
 * HiBob People API → employee rows (the identity spine, spec §5).
 * Leavers are retained (kept with a leave_date) so historical spend keeps its
 * attribution. Shape is indicative — confirm field paths against the tenant.
 */
export interface HibobResponse {
  employees: Array<{
    id: string;
    email: string;
    displayName: string;
    work?: { department?: string; site?: string };
    employmentStatus?: string;
    startDate?: string;
    leaveDate?: string;
  }>;
}

export function normalizeHibob(raw: HibobResponse): EmployeeUpsert[] {
  if (!raw || !Array.isArray(raw.employees)) {
    throw new SchemaDriftError("hibob", "missing `employees` array");
  }
  return raw.employees.map((e) => {
    if (!e.id || !e.email) {
      throw new SchemaDriftError("hibob", `row missing id/email: ${JSON.stringify(e)}`);
    }
    return {
      hibob_id: e.id,
      email: e.email.toLowerCase(),
      full_name: e.displayName ?? "",
      department: e.work?.department ?? null,
      site: e.work?.site ?? null,
      employment_status: e.employmentStatus ?? null,
      start_date: e.startDate ?? null,
      leave_date: e.leaveDate ?? null,
    };
  });
}
