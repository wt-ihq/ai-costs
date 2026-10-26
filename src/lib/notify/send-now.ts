import { periodReadiness, waitingText } from "./period-readiness";
import { DEFAULT_BUDGET_MS, runNotify, type RunNotifyDeps } from "./run-notify";
import { inMonthlyWindow, latestCompleteKey } from "./schedule";
import type { Cadence, NotifyMode } from "./types";

/**
 * Data → Notifications "Send now" and the catch-up for people just added: the cron's own run,
 * limited to one digest, right now (run-notify.ts `only`). Claims are the same, so the hourly run
 * never repeats what went out here.
 */
export type SendNowDeps = Omit<RunNotifyDeps, "only" | "replay" | "mode"> & { mode: NotifyMode };

export type SendNowResult =
  | { ok: true; sent: number; alreadyHandled: number; failed: { name: string; detail: string }[]; notReached: string[]; held: string | null }
  | { ok: false; error: string };

export interface SendNowRequest {
  cadence: Cadence;
  periodKey: string;
  /** Weekly only: send even though its data isn't complete. A monthly is never forced. */
  force?: boolean;
  employeeIds?: string[];
  /** The mode the page showed when the button was pressed: a send in any other mode is refused. */
  expectedMode?: NotifyMode;
}

export const MODE_CHANGED = "The mode changed since this page loaded — reload the page and try again";

export async function sendNow(deps: SendNowDeps, req: SendNowRequest): Promise<SendNowResult> {
  if (req.expectedMode && req.expectedMode !== deps.mode) return { ok: false, error: MODE_CHANGED };
  if (deps.mode === "off") return { ok: false, error: "Choose Preview or Live first" };
  if (req.cadence === "daily") return { ok: false, error: "Only weekly and monthly digests can be sent now" };
  const cadence = req.cadence;
  try {
    const only = { cadence, periodKey: req.periodKey, force: cadence === "weekly" && !!req.force, employeeIds: req.employeeIds };
    const r = await runNotify({ ...deps, mode: deps.mode, only });
    const names = new Map((await deps.store.employees()).map((e) => [e.id, e.fullName]));
    const name = (id: string) => names.get(id) ?? "Unknown";
    const failed = r.people.filter((p) => p.status === "failed").map((p) => ({ name: name(p.employeeId), detail: p.detail ?? "failed" }));
    const notReached = r.people.filter((p) => p.status === "notReached").map((p) => name(p.employeeId));
    let held: string | null = null;
    if (r.held.length) {
      const parts: string[] = [];
      const missing = (await periodReadiness(deps.store, cadence, req.periodKey, deps.now)).missing;
      if (missing.length) parts.push(waitingText(missing));
      if (cadence === "monthly" && !inMonthlyWindow(deps.now.toISOString().slice(0, 10))) parts.push("Due from the 3rd");
      held = parts.join(" · ") || "Not ready";
    }
    return { ok: true, sent: r.sent, alreadyHandled: r.alreadyHandled, failed, notReached, held };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * People just added to the Pilot list get the latest complete week now (if they have Weekly) and
 * last month's recap (if they have Monthly and it is ready). Anyone who already had one is skipped by
 * the claim. A held monthly is reported in `held`, not as an error.
 */
export async function catchUp(deps: SendNowDeps, employeeIds: string[], expectedMode?: NotifyMode): Promise<SendNowResult> {
  // One time budget for both runs: the action runs inside one function invocation.
  const clock = deps.clock ?? Date.now;
  const start = clock();
  const budget = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const weekly = await sendNow({ ...deps, budgetMs: budget }, { cadence: "weekly", periodKey: latestCompleteKey("weekly", deps.now), employeeIds, expectedMode });
  if (!weekly.ok) return weekly;
  const left = budget - (clock() - start);
  let monthly: SendNowResult;
  if (left > 0) {
    monthly = await sendNow({ ...deps, budgetMs: left }, { cadence: "monthly", periodKey: latestCompleteKey("monthly", deps.now), employeeIds, expectedMode });
  } else {
    // Out of time: the monthly's people are reported as not reached; nothing was claimed for them.
    const names = new Map((await deps.store.employees()).map((e) => [e.id, e.fullName]));
    const monthlyIds = new Set((await deps.store.subscriptions(["monthly"])).map((s) => s.employeeId));
    monthly = { ok: true, sent: 0, alreadyHandled: 0, failed: [], notReached: employeeIds.filter((id) => monthlyIds.has(id)).map((id) => names.get(id) ?? "Unknown"), held: null };
  }
  if (!monthly.ok) return monthly;
  return {
    ok: true,
    sent: weekly.sent + monthly.sent,
    alreadyHandled: weekly.alreadyHandled + monthly.alreadyHandled,
    failed: [...weekly.failed, ...monthly.failed],
    notReached: [...weekly.notReached, ...monthly.notReached],
    held: weekly.held ?? monthly.held,
  };
}
