import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CursorEventsResponse } from "./normalizers/cursor";
import { eventChunks, eventsWindow, syncCursorEvents } from "./run-cursor";

describe("eventChunks", () => {
  it("splits a window into consecutive exclusive-end chunks, the last one short", () => {
    expect(eventChunks({ startDate: "2026-10-01", endDate: "2026-10-08" })).toEqual([
      { startDate: "2026-10-01", endDate: "2026-10-04" },
      { startDate: "2026-10-04", endDate: "2026-10-07" },
      { startDate: "2026-10-07", endDate: "2026-10-08" },
    ]);
  });

  it("crosses month ends and handles a one-day or empty window", () => {
    expect(eventChunks({ startDate: "2026-09-29", endDate: "2026-10-03" })).toEqual([
      { startDate: "2026-09-29", endDate: "2026-10-02" },
      { startDate: "2026-10-02", endDate: "2026-10-03" },
    ]);
    expect(eventChunks({ startDate: "2026-10-01", endDate: "2026-10-02" })).toHaveLength(1);
    expect(eventChunks({ startDate: "2026-10-02", endDate: "2026-10-02" })).toEqual([]);
  });
});

describe("eventsWindow", () => {
  const monthToDate = { startDate: "2026-10-01", endDate: "2026-10-17" };

  it("keeps the whole window for backfills and rebuilds", () => {
    expect(eventsWindow(monthToDate)).toEqual(monthToDate);
  });

  it("narrows the nightly run to the last few days", () => {
    expect(eventsWindow(monthToDate, 3)).toEqual({ startDate: "2026-10-14", endDate: "2026-10-17" });
  });

  it("never reaches before the window", () => {
    expect(eventsWindow({ startDate: "2026-10-01", endDate: "2026-10-02" }, 3)).toEqual({ startDate: "2026-10-01", endDate: "2026-10-02" });
  });
});

/** spend_facts + raw_payloads, supporting the calls syncCursorEvents makes. */
function fakeDb(initial: Record<string, unknown>[]) {
  const rows: Record<string, unknown>[] = initial.map((r, i) => ({ id: `seed${i}`, ...r }));
  const raw: unknown[] = [];
  let nextId = 0;
  const factKey = (x: Record<string, unknown>) => `${x.source}|${x.day}|${x.cost_type}|${x.entity_key}|${x.model}`;
  const client = {
    from: (table: string) =>
      table === "raw_payloads"
        ? { insert: (r: unknown) => { raw.push(r); return Promise.resolve({ error: null }); } }
        : {
            upsert: (incoming: Record<string, unknown>[]) => {
              for (const r of incoming) {
                const idx = rows.findIndex((x) => factKey(x) === factKey(r));
                if (idx >= 0) rows[idx] = { ...rows[idx], ...r };
                else rows.push({ id: `new${nextId++}`, ...r });
              }
              return Promise.resolve({ error: null });
            },
            select: () => {
              const filters: ((r: Record<string, unknown>) => boolean)[] = [];
              const q = {
                eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
                gte: (c: string, v: string) => { filters.push((r) => (r[c] as string) >= v); return q; },
                lt: (c: string, v: string) => { filters.push((r) => (r[c] as string) < v); return q; },
                order: () => q,
                range: (from: number, to: number) => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }),
              };
              return q;
            },
            delete: () => ({
              in: (_c: string, ids: string[]) => {
                for (const id of ids) {
                  const i = rows.findIndex((r) => r.id === id);
                  if (i >= 0) rows.splice(i, 1);
                }
                return Promise.resolve({ error: null });
              },
            }),
          },
  } as unknown as SupabaseClient;
  return { client, rows, raw };
}

const at = (day: string) => Date.parse(`${day}T12:00:00Z`).toString();
const fact = (day: string, entity: string, model: string, usd: number) =>
  ({ source: "cursor", day, cost_type: "overage", entity_key: entity, model, cost_usd: usd });

describe("syncCursorEvents", () => {
  const employees = [{ id: "e1", email: "a@intenthq.com" }];
  const events: Record<string, CursorEventsResponse> = {
    // Day 1: only plan-included usage now. Day 2: on-demand plus a service account.
    "2026-10-11": { usageEvents: [{ timestamp: at("2026-10-11"), userEmail: "a@intenthq.com", model: "auto", kind: "Included in Business", isChargeable: true, chargedCents: 900 }] },
    "2026-10-12": { usageEvents: [
      { timestamp: at("2026-10-12"), userEmail: "a@intenthq.com", model: "gpt-5", kind: "Usage-based", isChargeable: true, chargedCents: 250 },
      { timestamp: at("2026-10-12"), serviceAccountId: "sa_1", model: "gpt-5", kind: "Usage-based", isChargeable: true, chargedCents: 100 },
    ] },
  };
  // One-day chunks are easiest to read: hand the fetcher's window to the fixture by its start.
  const fetcher = async (w: { startDate: string; endDate: string }) => {
    const out: NonNullable<CursorEventsResponse["usageEvents"]> = [];
    for (let d = w.startDate; d < w.endDate; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(...(events[d]?.usageEvents ?? []));
    return { usageEvents: out };
  };

  it("replaces the window's overage with on-demand spend only, pruning rows made of included usage", async () => {
    const db = fakeDb([
      fact("2026-10-11", "a@intenthq.com", "auto", 9), // old row, all plan-included usage
      fact("2026-10-12", "a@intenthq.com", "gpt-5", 6.5), // old inflated row
      { source: "cursor", day: "2026-10-01", cost_type: "seat", entity_key: "a@intenthq.com", model: "", cost_usd: 40 },
      fact("2026-10-20", "a@intenthq.com", "gpt-5", 3), // outside the window
    ]);
    const r = await syncCursorEvents(db.client, "run1", { startDate: "2026-10-11", endDate: "2026-10-13" }, fetcher, employees);

    expect(r.unmatched).toEqual(["cursor service account sa_1"]);
    const got = db.rows.map((x) => `${x.cost_type}|${x.day}|${x.entity_key}|${x.model}|${x.cost_usd}`).sort();
    expect(got).toEqual([
      "overage|2026-10-12|a@intenthq.com|gpt-5|2.5",
      "overage|2026-10-12|cursor service account sa_1|gpt-5|1",
      "overage|2026-10-20|a@intenthq.com|gpt-5|3",
      "seat|2026-10-01|a@intenthq.com||40",
    ]);
    expect(db.rows.find((x) => x.entity_key === "a@intenthq.com" && x.day === "2026-10-12")!.employee_id).toBe("e1");
  });

  it("saves each chunk's raw response", async () => {
    const db = fakeDb([]);
    await syncCursorEvents(db.client, "run1", { startDate: "2026-10-11", endDate: "2026-10-17" }, fetcher, employees);
    expect(db.raw).toHaveLength(2); // 11–13, 14–16
  });

  it("leaves a chunk alone when Cursor returns no events at all (an empty answer is no update)", async () => {
    const db = fakeDb([fact("2026-10-15", "a@intenthq.com", "gpt-5", 4)]);
    await syncCursorEvents(db.client, "run1", { startDate: "2026-10-14", endDate: "2026-10-17" }, fetcher, employees);
    expect(db.rows).toHaveLength(1);
  });
});
