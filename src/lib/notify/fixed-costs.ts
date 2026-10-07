/**
 * Whether Slack digests count fixed costs — seats and subscriptions. An admin
 * setting (notification_settings): organisation default, overridden per team
 * (Okta department), overridden per person. No setting at all = exclude.
 */
export interface FixedCostSettings {
  orgInclude: boolean;
  departments: Record<string, boolean>;
  employees: Record<string, boolean>;
}

export const NO_FIXED_COST_SETTINGS: FixedCostSettings = { orgInclude: false, departments: {}, employees: {} };

export type FixedCostSource = "person" | "team" | "default";
export interface FixedCostChoice {
  include: boolean;
  source: FixedCostSource; // which level decided it — shown in the admin preview
}

/** A person's digest: their override, else their team's, else the organisation default. */
export function fixedCostsFor(s: FixedCostSettings, e: { id: string; department: string | null }): FixedCostChoice {
  if (e.id in s.employees) return { include: s.employees[e.id], source: "person" };
  return fixedCostsForTeam(s, e.department);
}

/** A team digest (and a person with no override of their own). */
export function fixedCostsForTeam(s: FixedCostSettings, department: string | null): FixedCostChoice {
  if (department !== null && department in s.departments) return { include: s.departments[department], source: "team" };
  return { include: s.orgInclude, source: "default" };
}
