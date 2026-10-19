import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncEcb } from "./run-ecb";

const xml = `<gesmes:Envelope><Cube><Cube time='2026-10-16'><Cube currency='USD' rate='1.1253'/><Cube currency='GBP' rate='0.84385'/></Cube></Cube></gesmes:Envelope>`;

function fakeDb() {
  const upserts: { rows: Record<string, unknown>[]; opts: unknown }[] = [];
  const runs: Record<string, unknown>[] = [];
  const client = {
    from: (table: string) => {
      if (table === "sync_runs") {
        return {
          insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: "run1" }, error: null }) }) }),
          update: (patch: Record<string, unknown>) => { runs.push(patch); return { eq: () => Promise.resolve({ error: null }) }; },
        };
      }
      if (table === "raw_payloads") return { insert: () => Promise.resolve({ error: null }) };
      if (table === "fx_rates") return { upsert: (rows: Record<string, unknown>[], opts: unknown) => { upserts.push({ rows, opts }); return Promise.resolve({ error: null }); } };
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, upserts, runs };
}

describe("syncEcb", () => {
  it("stores dollars per pound and per euro, dated by the ECB, marked as ECB", async () => {
    const db = fakeDb();
    expect(await syncEcb(db.client, async () => xml)).toEqual({ rowsWritten: 2 });
    expect(db.upserts[0].rows).toEqual([
      { currency: "GBP", usd_per_unit: 1.333531, effective_from: "2026-10-16", source: "ecb" },
      { currency: "EUR", usd_per_unit: 1.1253, effective_from: "2026-10-16", source: "ecb" },
    ]);
    expect(db.upserts[0].opts).toEqual({ onConflict: "currency,effective_from" });
    expect(db.runs.at(-1)).toMatchObject({ status: "success" });
  });

  it("records a failed run and writes nothing when the ECB file is unusable", async () => {
    const db = fakeDb();
    await expect(syncEcb(db.client, async () => "<html>maintenance</html>")).rejects.toThrow();
    expect(db.upserts).toEqual([]);
    expect(db.runs.at(-1)).toMatchObject({ status: "failed" });
  });
});
