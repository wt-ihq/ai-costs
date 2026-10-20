import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addSubscriptions, lastSentLabels, openRate, removeSubscriptions, setSubscription, summariseLastRun } from "./admin-store";

const row = (employee_id: string, mode: string, cadence: string, updated_at: string, status = "sent") => ({ employee_id, mode, cadence, status, updated_at });

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
  it("counts live digests sent and how many were opened; previews and failures don't count", () => {
    expect(
      openRate([
        { mode: "live", status: "sent", opened_at: null },
        { mode: "live", status: "sent", opened_at: "2026-10-12T10:00:00Z" },
        { mode: "preview", status: "sent", opened_at: "2026-10-12T10:00:00Z" },
        { mode: "live", status: "failed", opened_at: null },
      ]),
    ).toEqual({ sent: 2, opened: 1 });
  });
});

/** Records each query-builder call by table; every query resolves to one written row. */
function fakeSupabase() {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const op of ["upsert", "delete", "eq", "select"]) {
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
