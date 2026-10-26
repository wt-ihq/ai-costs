import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { currentMode, readStoredMode, writeStoredMode } from "./mode-store";

/** notification_config as a one-row fake: records the upsert, answers the select. */
function fakeConfigDb(initial: { key: string; value: string }[] = []) {
  const rows = [...initial];
  const upserts: { row: Record<string, unknown>; opts: unknown }[] = [];
  const client = {
    from: (table: string) => {
      if (table !== "notification_config") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_c: string, v: string) => ({
            maybeSingle: () => Promise.resolve({ data: rows.find((r) => r.key === v) ?? null, error: null }),
          }),
        }),
        upsert: (row: Record<string, unknown>, opts: unknown) => {
          upserts.push({ row, opts });
          const i = rows.findIndex((r) => r.key === row.key);
          const next = { key: row.key as string, value: row.value as string };
          if (i >= 0) rows[i] = next;
          else rows.push(next);
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, rows, upserts };
}

afterEach(() => vi.unstubAllEnvs());

describe("mode-store", () => {
  it("readStoredMode: null with no row, the value with one", async () => {
    expect(await readStoredMode(fakeConfigDb().client)).toBeNull();
    expect(await readStoredMode(fakeConfigDb([{ key: "mode", value: "preview" }]).client)).toBe("preview");
  });

  it("writeStoredMode upserts the single mode row with who changed it", async () => {
    const db = fakeConfigDb();
    await writeStoredMode(db.client, "live", "gareth@x.com");
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].row).toEqual({ key: "mode", value: "live", updated_by: "gareth@x.com", updated_at: expect.any(String) });
    expect(db.upserts[0].opts).toEqual({ onConflict: "key" });
    expect(await readStoredMode(db.client)).toBe("live");
  });

  it("currentMode resolves the stored value against the environment", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SLACK_NOTIFY_MODE", "off");
    expect(await currentMode(fakeConfigDb([{ key: "mode", value: "live" }]).client)).toBe("live");
    expect(await currentMode(fakeConfigDb().client)).toBe("off");
  });
});
