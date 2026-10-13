import type { Vendor } from "@/lib/types";

/** Default team for people who left and whose old team is unknown. */
export const FORMER_USERS_TEAM = "Former users";

export type FormerUserInput = { name: string; email: string; team: string; left: string };

export type FormerUserRow = {
  email: string;
  full_name: string;
  department: string;
  employment_status: "leaver";
  leave_date: string | null;
  okta_id: null;
  hibob_id: null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Validate and default a manually-created leaver. `knownDepartments` are the
 * existing departments; `existingEmails` are all employee emails (duplicate check).
 */
export function buildFormerUserRow(
  input: FormerUserInput,
  knownDepartments: readonly string[],
  existingEmails: readonly string[],
): { ok: true; row: FormerUserRow } | { ok: false; error: string } {
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "Name is required" };
  if (name.length > 200) return { ok: false, error: "Name is too long (200 characters max)" };

  const email = (input.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address" };
  if (existingEmails.some((e) => e.toLowerCase() === email)) {
    return { ok: false, error: "That email already exists — pick them from the list" };
  }

  const team = (input.team ?? "").trim() || FORMER_USERS_TEAM;
  if (team !== FORMER_USERS_TEAM && !knownDepartments.includes(team)) {
    return { ok: false, error: "Unknown team" };
  }

  const left = (input.left ?? "").trim();
  if (left && !MONTH_RE.test(left)) return { ok: false, error: "Left month must look like 2026-03" };

  return {
    ok: true,
    row: {
      email,
      full_name: name,
      department: team,
      employment_status: "leaver",
      leave_date: left ? `${left}-01` : null,
      okta_id: null,
      hibob_id: null,
    },
  };
}

export type OwnerOverrideTarget =
  | { table: "api_keys"; column: "external_key_id"; conflict: "vendor,external_key_id" }
  | { table: "projects"; column: "external_id"; conflict: "vendor,external_id" };

/**
 * Where a durable owner override lives for a source's entity key, if anywhere.
 * Anthropic keys and OpenAI projects are re-derived from their creator/owner on
 * every sync; the override is what makes a manual assignment survive that.
 * Other sources match by email, so the identities row is enough.
 */
export function ownerOverrideTarget(source: Vendor, entityKey: string): OwnerOverrideTarget | null {
  if (source === "anthropic") return { table: "api_keys", column: "external_key_id", conflict: "vendor,external_key_id" };
  if (source === "openai" && entityKey !== "org") return { table: "projects", column: "external_id", conflict: "vendor,external_id" };
  return null;
}
