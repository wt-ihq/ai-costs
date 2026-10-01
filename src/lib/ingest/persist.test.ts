import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { attachEmployees, planEmployeeUpserts, upsertEmployees, upsertSpendFacts, replaceWindowFacts, type ResolvedFact } from "./persist";
import { normalizeCursor } from "./normalizers/cursor";
import { cursorUsageFixture } from "./fixtures/cursor-usage";

const employees = [
  { id: "g", email: "gareth.jones@intenthq.com" },
  { id: "t", email: "tom.reeve@intenthq.com" },
];

describe("attachEmployees", () => {
  it("attaches employee_id by email and collects unmatched keys", () => {
    const facts = normalizeCursor(cursorUsageFixture);
    const { facts: resolved, unmatched } = attachEmployees(facts, employees);

    expect(resolved.find((f) => f.entityKey === "gareth.jones@intenthq.com")?.employeeId).toBe("g");
    expect(resolved.find((f) => f.entityKey === "tom.reeve@intenthq.com")?.employeeId).toBe("t");
    expect(resolved.find((f) => f.entityKey === "contractor@external.dev")?.employeeId).toBeNull();
    expect(unmatched).toEqual(["contractor@external.dev"]);
  });
});

describe("upsertSpendFacts", () => {
  it("collapses duplicate conflict keys so ON CONFLICT can't hit a row twice", async () => {
    let sent: Record<string, unknown>[] = [];
    const fake = {
      from: () => ({
        upsert: (rows: Record<string, unknown>[]) => {
          sent = rows;
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;

    // Same (cursor, 2026-06-01, seat, email, '') from an active-user seat AND a
    // member seat — must collapse to one row before the upsert.
    const seat = (employeeId: string | null): ResolvedFact => ({
      source: "cursor", day: "2026-06-01", costType: "seat", entityKey: "gareth.jones@intenthq.com", costUsd: 40, employeeId,
    });
    const written = await upsertSpendFacts(fake, [seat("g"), seat("g")]);

    expect(written).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

/** Stateful in-memory spend_facts table supporting the exact call chains replaceWindowFacts makes. */
function fakeSpendFactsDb(initial: Record<string, unknown>[]) {
  const rows: Record<string, unknown>[] = initial.map((r, i) => ({ id: `seed${i}`, ...r }));
  let nextId = 0;
  const client = {
    from: () => ({
      upsert: (incoming: Record<string, unknown>[]) => {
        for (const r of incoming) {
          const key = (x: Record<string, unknown>) => `${x.source}|${x.day}|${x.cost_type}|${x.entity_key}|${x.model}`;
          const idx = rows.findIndex((x) => key(x) === key(r));
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
          range: (from: number, to: number) =>
            Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }),
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
    }),
  } as unknown as SupabaseClient;
  return { client, rows };
}

describe("replaceWindowFacts with a cost-type scope", () => {
  it("prunes stale rows only within the scoped cost type — seat facts survive an overage replace", async () => {
    const { client, rows } = fakeSpendFactsDb([
      // paste-era seat fact — must survive
      { source: "chatgpt_business", day: "2026-05-01", cost_type: "seat", entity_key: "alex morgan", model: "", cost_usd: 25 },
      // paste-era month-stamped overage — must be pruned (not in the new snapshot)
      { source: "chatgpt_business", day: "2026-05-01", cost_type: "overage", entity_key: "alex morgan", model: "", cost_usd: 360 },
      // other source in-window — must survive
      { source: "claude_team", day: "2026-05-10", cost_type: "overage", entity_key: "x@intenthq.com", model: "", cost_usd: 9 },
    ]);

    const written = await replaceWindowFacts(
      client,
      "chatgpt_business",
      { startDate: "2026-05-01", endDate: "2026-06-01" },
      [{
        source: "chatgpt_business", day: "2026-05-02", costType: "overage",
        entityKey: "alex.morgan@intenthq.com", costUsd: 7.03, model: "GPT-5.5 Codex (fast)", employeeId: "e1",
      }],
      { costType: "overage" },
    );

    expect(written).toBe(1);
    const keys = rows.map((r) => `${r.source}|${r.cost_type}|${r.entity_key}`);
    expect(keys).toContain("chatgpt_business|seat|alex morgan");                 // survived
    expect(keys).toContain("claude_team|overage|x@intenthq.com");             // survived
    expect(keys).toContain("chatgpt_business|overage|alex.morgan@intenthq.com"); // new fact
    expect(keys).not.toContain("chatgpt_business|overage|alex morgan");          // pruned
  });
});

/**
 * Fake `employees` table that enforces the real unique constraints (id, email,
 * okta_id) per statement, the way Postgres does: an upsert either applies whole
 * or fails with the same "duplicate key" message production returned.
 */
function fakeEmployeesDb(seed: Record<string, unknown>[]) {
  const rows: Record<string, unknown>[] = seed.map((r) => ({ ...r }));
  let nextId = 0;
  const client = {
    from: (table: string) => {
      if (table !== "employees") throw new Error(`unexpected table ${table}`);
      return {
        select: () => {
          const q = {
            order: () => q,
            range: (from: number, to: number) =>
              Promise.resolve({
                data: rows.slice(from, to + 1).map((r) => ({ id: r.id, email: r.email, okta_id: r.okta_id ?? null })),
                error: null,
              }),
          };
          return q;
        },
        upsert: (incoming: Record<string, unknown>[], opts: { onConflict: string }) => {
          const staged = rows.map((r) => ({ ...r }));
          for (const inc of incoming) {
            const i = staged.findIndex((r) => r[opts.onConflict] === inc[opts.onConflict]);
            if (i >= 0) staged[i] = { ...staged[i], ...inc };
            else staged.push({ id: inc.id ?? `new${nextId++}`, ...inc });
          }
          for (const col of ["id", "email", "okta_id"]) {
            const vals = staged.map((r) => r[col]).filter((v) => v != null);
            if (new Set(vals).size !== vals.length) {
              return Promise.resolve({ error: { message: `duplicate key value violates unique constraint "employees_${col}_key"` } });
            }
          }
          rows.splice(0, rows.length, ...staged);
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as SupabaseClient;
  return { rows, client };
}

const oktaRow = (okta_id: string, email: string, over: Record<string, unknown> = {}) => ({
  okta_id, email, full_name: email, department: "Eng", site: null, employment_status: "active",
  start_date: null, leave_date: null, manager_ref: null, employee_number: null, ...over,
});

describe("upsertEmployees", () => {
  it("updates the existing row when an Okta user's email changes (staged personal address → company address)", async () => {
    // Production, 29 Jul 2026 onwards: a pre-provisioned account was stored with a
    // personal address, then activated with the company one. Keying on email tried to
    // insert a second row with the same okta_id and failed the whole sync every night.
    const db = fakeEmployeesDb([
      { id: "e1", email: "jane.personal@example.org", okta_id: "00uJ", employment_status: "staged" },
      { id: "e2", email: "tom@intenthq.com", okta_id: "00uT", employment_status: "active" },
    ]);
    const written = await upsertEmployees(db.client, [
      oktaRow("00uJ", "jane.doe@intenthq.com"),
      oktaRow("00uT", "tom@intenthq.com"),
      oktaRow("00uN", "new.joiner@intenthq.com"),
    ]);
    expect(written).toBe(3);
    expect(db.rows).toHaveLength(3);
    expect(db.rows.find((r) => r.id === "e1")).toMatchObject({ email: "jane.doe@intenthq.com", okta_id: "00uJ", employment_status: "active" });
    expect(db.rows.find((r) => r.okta_id === "00uN")).toMatchObject({ email: "new.joiner@intenthq.com" });
  });

  it("is a no-op for an empty roster", async () => {
    const db = fakeEmployeesDb([{ id: "e1", email: "a@x.com", okta_id: "00uA" }]);
    expect(await upsertEmployees(db.client, [])).toBe(0);
    expect(db.rows).toHaveLength(1);
  });
});

describe("planEmployeeUpserts", () => {
  it("matches by okta_id first, then email (legacy rows without okta_id get it set), else inserts", () => {
    const plan = planEmployeeUpserts(
      [
        { id: "e1", email: "old@personal.example", okta_id: "00uA" },
        { id: "e2", email: "legacy@intenthq.com", okta_id: null },
      ],
      [oktaRow("00uA", "new@intenthq.com"), oktaRow("00uB", "legacy@intenthq.com"), oktaRow("00uC", "fresh@intenthq.com")],
    );
    expect(plan.updates.map((r) => [r.id, r.email, r.okta_id])).toEqual([
      ["e1", "new@intenthq.com", "00uA"],
      ["e2", "legacy@intenthq.com", "00uB"],
    ]);
    expect(plan.inserts.map((r) => r.email)).toEqual(["fresh@intenthq.com"]);
    expect(plan.clashes).toEqual([]);
  });

  it("keeps the row's current email when the new address already belongs to another row", () => {
    const plan = planEmployeeUpserts(
      [
        { id: "e1", email: "old@personal.example", okta_id: "00uA" },
        { id: "e2", email: "taken@intenthq.com", okta_id: null },
      ],
      [oktaRow("00uA", "taken@intenthq.com")],
    );
    expect(plan.updates).toEqual([expect.objectContaining({ id: "e1", email: "old@personal.example", okta_id: "00uA" })]);
    expect(plan.inserts).toEqual([]);
    expect(plan.clashes).toEqual(["00uA"]);
  });

  it("never targets the same existing row twice in one batch", () => {
    // A takes over e1 by okta_id (email change); B arrives with e1's OLD address.
    const plan = planEmployeeUpserts(
      [{ id: "e1", email: "old@intenthq.com", okta_id: "00uA" }],
      [oktaRow("00uA", "renamed@intenthq.com"), oktaRow("00uB", "old@intenthq.com")],
    );
    expect(plan.updates.map((r) => r.id)).toEqual(["e1"]);
    expect(plan.inserts.map((r) => r.okta_id)).toEqual(["00uB"]);
  });

  it("lets okta_id matches win across the whole batch, whatever order Okta returns users in", () => {
    // Same as above but B (who now has e1's OLD address) comes first: B must not
    // take over e1 by email — that would silently move A's spend history to B.
    const plan = planEmployeeUpserts(
      [{ id: "e1", email: "old@intenthq.com", okta_id: "00uA" }],
      [oktaRow("00uB", "old@intenthq.com"), oktaRow("00uA", "renamed@intenthq.com")],
    );
    expect(plan.updates.map((r) => [r.id, r.okta_id, r.email])).toEqual([["e1", "00uA", "renamed@intenthq.com"]]);
    expect(plan.inserts.map((r) => r.okta_id)).toEqual(["00uB"]);
  });

  it("skips a new person whose address is still held after the updates, instead of overwriting that row", () => {
    // A wants X (held by legacy row L) so e1 keeps P; new user D arrives with P.
    // Inserting D would ON CONFLICT (email) rewrite e1 — A's row — with D's identity.
    const plan = planEmployeeUpserts(
      [
        { id: "e1", email: "p@intenthq.com", okta_id: "00uA" },
        { id: "L", email: "x@intenthq.com", okta_id: null },
      ],
      [oktaRow("00uA", "x@intenthq.com"), oktaRow("00uD", "p@intenthq.com")],
    );
    expect(plan.updates.map((r) => [r.id, r.email])).toEqual([["e1", "p@intenthq.com"]]);
    expect(plan.inserts).toEqual([]);
    expect(plan.skipped).toEqual(["00uD"]);
  });
});
