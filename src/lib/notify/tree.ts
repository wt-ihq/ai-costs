import { isActiveEmployee, type NotifyEmployee } from "./types";

export interface ReportingTree {
  /** All descendants (direct + indirect), never including the manager. */
  reportsOf(employeeId: string): string[];
  managerOf(employeeId: string): string | null;
  /** ACTIVE employees with no resolvable manager (the admin "Manager chain" card). */
  unresolved: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Okta's managerId is a free-text profile attribute whose format varies by
 * tenant (Okta id, email, or employee number), so it is matched against all
 * three keys. Resolved at read time from the current roster — never stored —
 * so the tree always matches the latest Okta sync. The descendant walk keeps
 * a visited set: bad HR data does produce A→B→A loops.
 */
export function buildReportingTree(employees: NotifyEmployee[]): ReportingTree {
  const idByKey = new Map<string, string>();
  for (const e of employees) {
    for (const k of [e.oktaId, e.email, e.employeeNumber]) {
      if (k && !idByKey.has(norm(k))) idByKey.set(norm(k), e.id);
    }
  }

  const managerOf = new Map<string, string>();
  const children = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const e of employees) {
    const managerId = e.managerRef ? idByKey.get(norm(e.managerRef)) : undefined;
    if (managerId && managerId !== e.id) {
      managerOf.set(e.id, managerId);
      const list = children.get(managerId) ?? [];
      list.push(e.id);
      children.set(managerId, list);
    } else if (isActiveEmployee(e)) {
      unresolved.push(e.id);
    }
  }

  const memo = new Map<string, string[]>();
  return {
    managerOf: (id) => managerOf.get(id) ?? null,
    reportsOf(id) {
      const hit = memo.get(id);
      if (hit) return hit;
      const out: string[] = [];
      const seen = new Set<string>([id]);
      const stack = [...(children.get(id) ?? [])];
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        stack.push(...(children.get(c) ?? []));
      }
      memo.set(id, out);
      return out;
    },
    unresolved,
  };
}
