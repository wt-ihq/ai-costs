import { personHref } from "./digest";
import type { NotifyStore } from "./store";
import { isUuid } from "./types";

/**
 * Where a digest's "Open in dashboard" link lands, after stamping the send's first open: the
 * recipient's own Explore page, the Company page for the company report, or /recommendations. Unknown → Explore.
 */
export async function openRedirectPath(store: Pick<NotifyStore, "markOpened">, sendId: string): Promise<string> {
  if (!isUuid(sendId)) return "/explore";
  const opened = await store.markOpened(sendId);
  if (!opened || opened.report === "company") return "/explore";
  if (opened.report === "recommendations") return "/recommendations";
  return personHref("", { id: opened.employeeId, department: opened.department });
}
