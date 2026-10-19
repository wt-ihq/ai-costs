import type { ReportingTree } from "./tree";
import { isActiveEmployee, type Cadence, type NotifyEmployee } from "./types";

/**
 * The reporting lines as a tree for Data → Notifications' recipient picker. Plain, serialisable
 * objects (the picker is a client component). Active people only.
 */
export interface OrgNode {
  id: string;
  name: string;
  team: string | null;
  directCount: number; // active direct reports
  totalCount: number; // active people anywhere below
  personal: Cadence[]; // current personal-digest cadences
  company: Cadence[]; // current company-report cadences
  children: OrgNode[];
}

export interface OrgTree {
  /** The top of each reporting line: active people with no active manager who manage someone. */
  roots: OrgNode[];
  /** No manager in Okta and no reports, or caught in a manager loop: listed flat, apart. */
  noManager: OrgNode[];
  managerIds: string[]; // at least one active direct report
  seniorIds: string[]; // managers of managers
}

const byName = (a: OrgNode, b: OrgNode) => a.name.localeCompare(b.name);

export function buildOrgTree(
  employees: readonly NotifyEmployee[],
  tree: ReportingTree,
  personal: ReadonlyMap<string, Cadence[]>,
  company: ReadonlyMap<string, Cadence[]>,
): OrgTree {
  const active = employees.filter(isActiveEmployee);
  const activeIds = new Set(active.map((e) => e.id));
  const activeManager = (id: string) => {
    const m = tree.managerOf(id);
    return m && activeIds.has(m) ? m : null;
  };
  const children = new Map<string, NotifyEmployee[]>();
  for (const e of active) {
    const m = activeManager(e.id);
    if (m) children.set(m, [...(children.get(m) ?? []), e]);
  }

  const leaf = (e: NotifyEmployee): OrgNode => ({
    id: e.id,
    name: e.fullName,
    team: e.department,
    directCount: (children.get(e.id) ?? []).length,
    totalCount: tree.reportsOf(e.id).filter((id) => activeIds.has(id)).length,
    personal: personal.get(e.id) ?? [],
    company: company.get(e.id) ?? [],
    children: [],
  });

  const placed = new Set<string>();
  const grow = (e: NotifyEmployee): OrgNode => {
    placed.add(e.id);
    const node = leaf(e);
    // `placed` guards against loops: a loop's members are never reached from a top, so this only skips repeats.
    node.children = (children.get(e.id) ?? []).filter((c) => !placed.has(c.id)).map(grow).sort(byName);
    return node;
  };

  const tops = active.filter((e) => !activeManager(e.id) && (children.get(e.id) ?? []).length > 0);
  const roots = tops.map(grow).sort(byName);
  const noManager = active.filter((e) => !placed.has(e.id)).map(leaf).sort(byName);

  // Managers as the tree shows them: someone in a reporting loop manages no one there (and their
  // digest has no reports section), so they never count.
  const all = roots.flatMap(function walk(n: OrgNode): OrgNode[] { return [n, ...n.children.flatMap(walk)]; });
  const managerNodes = all.filter((n) => n.children.length > 0);
  const managerIds = managerNodes.map((n) => n.id);
  const seniorIds = managerNodes.filter((n) => n.children.some((c) => c.children.length > 0)).map((n) => n.id);
  return { roots, noManager, managerIds, seniorIds };
}

/** The person and everyone below them. */
export function branchIds(node: OrgNode): string[] {
  return [node.id, ...node.children.flatMap(branchIds)];
}

/** The person plus the managers in their branch. */
export function managersIn(node: OrgNode): string[] {
  return [node.id, ...node.children.flatMap((c) => (c.children.length > 0 ? managersIn(c) : []))];
}
