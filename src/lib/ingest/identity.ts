import type { Employee, MatchMethod } from "@/lib/types";

export interface IdentityMatch {
  employeeId: string | null;
  method: MatchMethod;
}

export interface AliasRule {
  /** vendor email/login that should map to a canonical employee email */
  alias: string;
  employeeEmail: string;
}

/**
 * Resolve a vendor identity to an employee (spec §5 attribution rules):
 *   1. exact email (case-insensitive)
 *   2. alias rule
 *   3. otherwise unmatched -> kept in the "Unmatched" bucket, never dropped.
 *
 * Manual overrides are applied at a higher layer (DB), not here.
 */
export function matchIdentity(
  vendorEmail: string | null | undefined,
  employees: Pick<Employee, "id" | "email">[],
  aliasRules: AliasRule[] = [],
): IdentityMatch {
  if (!vendorEmail) return { employeeId: null, method: "unmatched" };

  const needle = vendorEmail.trim().toLowerCase();
  const byEmail = new Map(employees.map((e) => [e.email.toLowerCase(), e.id]));

  const exact = byEmail.get(needle);
  if (exact) return { employeeId: exact, method: "exact_email" };

  const alias = aliasRules.find((r) => r.alias.toLowerCase() === needle);
  if (alias) {
    const target = byEmail.get(alias.employeeEmail.toLowerCase());
    if (target) return { employeeId: target, method: "alias_rule" };
  }

  return { employeeId: null, method: "unmatched" };
}
