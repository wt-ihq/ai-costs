/** Cursor service-account usage (normalizers/cursor.ts; kept here so this module stays client-safe). */
export const CURSOR_SERVICE_ACCOUNT = "cursor service account";

/**
 * By-design person-less entity keys. They carry real spend but must never be
 * offered for assignment — attributing them to an individual would be wrong.
 * Shared by Data Health (which files them under "Not person-attributable")
 * and Explore's Unattributed label (which must not call them unmatched keys).
 * Pure — safe to import from client code.
 */
export function isPseudoEntity(entityKey: string): boolean {
  return entityKey.startsWith("unassigned seats") || entityKey === "unkeyed" || entityKey === "org" || entityKey.startsWith(CURSOR_SERVICE_ACCOUNT);
}

/** One-line explanation for a pseudo-entity, shown beside its spend. */
export function pseudoExplanation(entityKey: string): string {
  if (entityKey.startsWith("unassigned seats")) return "Seat spend beyond known members — backfilled months without member data";
  if (entityKey === "unkeyed") return "Anthropic days with cost but no per-key usage rows to allocate";
  if (entityKey === "org") return "OpenAI org-level costs not tied to a project";
  if (entityKey.startsWith(CURSOR_SERVICE_ACCOUNT)) return "Cursor on-demand usage by a service account (background agents, API), not a person";
  return "";
}
