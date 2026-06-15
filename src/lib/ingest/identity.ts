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

export interface NameMatch {
  employeeId: string | null;
  method: MatchMethod;
  /** "high" => auto-apply; "low" => surface in the Data Health confirm queue */
  confidence: "high" | "low" | "none";
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Fuzzy-match a ChatGPT display name to an employee (no email available).
 * Display names are often abbreviated ("Gareth J", "Fernando M"), so:
 *   1. exact full-name match            -> high
 *   2. first name + last-initial match  -> high if unique, else low
 *   3. first-name-only match            -> low if unique
 * Ambiguous or no match -> queued for manual confirm, never silently dropped.
 */
export function matchByName(
  displayName: string | null | undefined,
  employees: Pick<Employee, "id" | "fullName">[],
): NameMatch {
  if (!displayName) return { employeeId: null, method: "unmatched", confidence: "none" };

  const target = norm(displayName);
  const people = employees.map((e) => ({ id: e.id, full: norm(e.fullName) }));

  const exact = people.filter((p) => p.full === target);
  if (exact.length === 1) {
    return { employeeId: exact[0].id, method: "exact_email", confidence: "high" };
  }

  const [first, ...rest] = target.split(" ");
  const lastInitial = rest.length ? rest[rest.length - 1].replace(/\.$/, "") : "";

  // "gareth j" => first "gareth", last starts with "j"
  if (lastInitial.length <= 2) {
    const byFirstLast = people.filter((p) => {
      const [pf, ...pr] = p.full.split(" ");
      const pl = pr.length ? pr[pr.length - 1] : "";
      return pf === first && (lastInitial === "" || pl.startsWith(lastInitial));
    });
    if (byFirstLast.length === 1) {
      return { employeeId: byFirstLast[0].id, method: "alias_rule", confidence: "high" };
    }
    if (byFirstLast.length > 1) {
      return { employeeId: null, method: "unmatched", confidence: "low" };
    }
  }

  const byFirst = people.filter((p) => p.full.split(" ")[0] === first);
  if (byFirst.length === 1) {
    return { employeeId: byFirst[0].id, method: "alias_rule", confidence: "low" };
  }

  return { employeeId: null, method: "unmatched", confidence: "none" };
}
