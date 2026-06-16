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

/**
 * Build an ID→name map from a HiBob named-list response
 * (`{ values: [{ id, name|value }] }`), used to resolve department IDs that
 * the people endpoint returns as list-item IDs rather than labels.
 */
export function buildNamedListMap(list: unknown): Map<string, string> {
  const values = (list as { values?: Array<{ id: string | number; name?: string; value?: string }> })?.values ?? [];
  return new Map(values.map((v) => [String(v.id), v.name ?? v.value ?? String(v.id)]));
}

/** Resolve employees' department IDs to names via the named-list map. */
export function resolveDepartments(employees: EmployeeUpsert[], deptMap: Map<string, string>): EmployeeUpsert[] {
  return employees.map((e) => ({
    ...e,
    department: e.department ? deptMap.get(String(e.department)) ?? e.department : e.department,
  }));
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
