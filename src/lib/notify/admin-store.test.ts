import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addSubscriptions, lastSentLabels, openRate, periodDigestSends, removeAllSubscriptions, removeSubscriptions, setSubscription, summariseLastRun } from "./admin-store";

const row = (employee_id: string, mode: string, cadence: string, updated_at: string, status = "sent") => ({ employee_id, mode, cadence, status, updated_at, report: "personal" });

describe("lastSentLabels", () => {
  it("takes each person's newest LIVE send; a preview only when they have no live one", () => {
    const labels = lastSentLabels([
      row("a", "preview", "daily", "2026-09-30T07:01:00Z"),
      row("b", "preview", "weekly", "2026-09-29T07:01:00Z"),
      row("a", "live", "weekly", "2026-09-28T07:01:00Z"),
      row("a", "live", "monthly", "2026-09-03T07:01:00Z"),
      row("b", "preview", "daily", "2026-09-27T07:01:00Z"),
    ]);
    expect(labels.get("a")).toBe("weekly · 2026-09-28");
    expect(labels.get("b")).toBe("preview · weekly · 2026-09-29");
    expect(labels.has("c")).toBe(false);
  });
});

describe("summariseLastRun", () => {
  it("is null with no sends", () => {
    expect(summariseLastRun([])).toBeNull();
  });

  it("leaves update reminders out: they're not digests", () => {
    const r = summariseLastRun([
      { ...row("g", "live", "weekly", "2026-10-19T08:30:00Z"), report: "reminder" },
      row("m", "live", "weekly", "2026-10-19T09:30:00Z"),
    ]);
    expect(r).toMatchObject({ day: "2026-10-19", sent: 1 });
    expect(summariseLastRun([{ ...row("g", "live", "weekly", "2026-10-19T08:30:00Z"), report: "reminder" }])).toBeNull();
  });

  it("leaves the recommendations message out: it shares the weekly key but isn't a digest", () => {
    const r = summariseLastRun([
      { ...row("g", "live", "weekly", "2026-11-09T10:45:00Z"), report: "recommendations" },
      { ...row("g", "live", "weekly", "2026-11-09T10:40:00Z", "failed"), report: "recommendations" },
      { ...row("m", "preview", "weekly", "2026-11-08T10:30:00Z"), report: "company" },
    ]);
    expect(r).toEqual({ day: "2026-11-08", mode: "preview", cadences: ["weekly"], sent: 1, skipped: 0, failed: 0, plusPreview: 0 });
    expect(summariseLastRun([{ ...row("g", "live", "weekly", "2026-11-09T10:45:00Z"), report: "recommendations" }])).toBeNull();
  });

  it("reports the latest day's mode, cadences and counts", () => {
    expect(
      summariseLastRun([
        row("a", "preview", "weekly", "2026-09-28T07:02:00Z"),
        row("b", "preview", "daily", "2026-09-28T07:01:00Z", "skipped"),
        row("c", "preview", "daily", "2026-09-28T07:00:30Z", "failed"),
        row("d", "live", "daily", "2026-09-27T07:00:00Z"),
      ]),
    ).toEqual({ day: "2026-09-28", mode: "preview", cadences: ["daily", "weekly"], sent: 1, skipped: 1, failed: 1, plusPreview: 0 });
  });

  it("shows live counts when both modes ran that day, plus the preview count", () => {
    expect(
      summariseLastRun([
        row("a", "preview", "weekly", "2026-09-28T09:00:00Z"),
        row("a", "preview", "daily", "2026-09-28T08:00:00Z"),
        row("b", "live", "weekly", "2026-09-28T07:01:00Z"),
        row("c", "live", "weekly", "2026-09-28T07:00:00Z", "failed"),
      ]),
    ).toEqual({ day: "2026-09-28", mode: "live", cadences: ["daily", "weekly"], sent: 1, skipped: 0, failed: 1, plusPreview: 2 });
  });
});

describe("openRate", () => {
  it("counts live digests sent and how many were opened; previews, failures and recommendations don't count", () => {
    expect(
      openRate([
        { mode: "live", status: "sent", report: "personal", opened_at: null },
        { mode: "live", status: "sent", report: "company", opened_at: "2026-10-12T10:00:00Z" },
        { mode: "preview", status: "sent", report: "personal", opened_at: "2026-10-12T10:00:00Z" },
        { mode: "live", status: "failed", report: "personal", opened_at: null },
        { mode: "live", status: "sent", report: "recommendations", opened_at: "2026-10-12T11:00:00Z" },
      ]),
    ).toEqual({ sent: 2, opened: 1 });
  });
});

describe("periodDigestSends (the Digests table's weekly row)", () => {
  const state = (report: string, status = "sent", periodKey = "2026-W45", cadence = "weekly") => ({ report, status, periodKey, cadence, updatedAt: "2026-11-09T10:45:00Z" });
  it("counts the week's personal and company digests only — not a recommendations send on the same key, nor a reminder", () => {
    expect(
      periodDigestSends([state("personal"), state("company", "failed"), state("recommendations"), state("reminder"), state("personal", "sent", "2026-W44"), state("personal", "sent", "2026-11", "monthly")], "weekly", "2026-W45"),
    ).toEqual([{ status: "sent", updatedAt: "2026-11-09T10:45:00Z" }, { status: "failed", updatedAt: "2026-11-09T10:45:00Z" }]);
  });
  it("a week whose only send is the recommendations message has no digest sends", () => {
    expect(periodDigestSends([state("recommendations")], "weekly", "2026-W45")).toEqual([]);
  });
});

/** Records each query-builder call by table; every query resolves to one written row. */
function fakeSupabase() {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const op of ["upsert", "delete", "eq", "neq", "select"]) {
      q[op] = (...args: unknown[]) => {
        calls.push({ table, op, args });
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => void) => resolve({ data: [{ employee_id: "e1" }], error: null });
    return q;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

describe("recipient writes", () => {
  it("company recipients go to their own table; personal ones stay where they were", async () => {
    const s = fakeSupabase();
    expect(await addSubscriptions(s.client, ["e1"], ["weekly"], "admin@x.com", "company")).toBe(1);
    await setSubscription(s.client, "e1", "daily", false, "admin@x.com", "company");
    await removeSubscriptions(s.client, "e1", "company");
    expect(new Set(s.calls.map((c) => c.table))).toEqual(new Set(["notification_company_recipients"]));
    expect(s.calls[0]).toMatchObject({
      op: "upsert",
      args: [[{ employee_id: "e1", cadence: "weekly", created_by: "admin@x.com" }], { onConflict: "employee_id,cadence", ignoreDuplicates: true }],
    });

    const p = fakeSupabase();
    await addSubscriptions(p.client, ["e1"], ["weekly"], "admin@x.com");
    await removeSubscriptions(p.client, "e1");
    expect(new Set(p.calls.map((c) => c.table))).toEqual(new Set(["notification_subscriptions"]));
  });
});

describe("removeAllSubscriptions (Remove everyone)", () => {
  it("empties the personal list only, with a filter that is always true, and returns how many went", async () => {
    const s = fakeSupabase();
    expect(await removeAllSubscriptions(s.client)).toBe(1);
    expect(new Set(s.calls.map((c) => c.table))).toEqual(new Set(["notification_subscriptions"]));
    expect(s.calls.map((c) => c.op)).toEqual(["delete", "neq", "select"]);
    expect(s.calls[1].args).toEqual(["cadence", ""]);
  });
});
