import { outstandingShort, type Readiness } from "./readiness";

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Data → Notifications' line for the latest complete week (spec §5). Pure. */
export function weekStatus(i: { label: string; readiness: Readiness; recipients: number; sent: number; today: string; weekToExclusive: string }) {
  const title = `Weekly ${i.label}`;
  if (i.sent > 0) return { state: "sent" as const, title, text: `Sent to ${i.sent} of ${i.recipients}` };
  const friday = addDays(i.weekToExclusive, 4); // the Friday after the week
  if (i.today > friday) return { state: "skipped" as const, title, text: "Skipped — not ready by Friday" };
  if (i.readiness.ready) return { state: "ready" as const, title, text: "Ready — going out from 10:30" };
  return { state: "waiting" as const, title, text: `Waiting for ${i.readiness.outstanding.map(outstandingShort).join(" · ")}` };
}
