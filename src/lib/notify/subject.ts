import type { Cadence } from "./types";

/** Whose numbers a preview or test shows. Client-safe: no server imports. */
export type TestSubject = { kind: "person"; employeeId: string } | { kind: "team"; department: string };
/** Who receives a test: the signed-in admin, the subject themself (people only), or any chosen employee. */
export type TestTarget = { kind: "me" } | { kind: "subject" } | { kind: "employee"; employeeId: string };

/** The Notifications tab's link-driven preview URL (state lives in the URL, not in the client). */
export function previewHref(subject: TestSubject, cadence: Cadence, key?: string | null): string {
  const who = subject.kind === "person" ? `preview=${subject.employeeId}` : `team=${encodeURIComponent(subject.department)}`;
  return `/data?tab=notifications&${who}&cadence=${cadence}${key ? `&at=${key}` : ""}`;
}
