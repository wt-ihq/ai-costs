import { personHref } from "./digest";
import type { NotifyStore } from "./store";
import { isUuid } from "./types";

/** Where a digest's "Open in dashboard" link lands, after stamping the send's first open. Unknown → Explore. */
export async function openRedirectPath(store: Pick<NotifyStore, "markOpened">, sendId: string): Promise<string> {
  if (!isUuid(sendId)) return "/explore";
  const opened = await store.markOpened(sendId);
  return opened ? personHref("", { id: opened.employeeId, department: opened.department }) : "/explore";
}
