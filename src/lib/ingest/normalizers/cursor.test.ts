import { describe, expect, it } from "vitest";
import { priceCursorSeats, normalizeCursor, normalizeCursorEvents, normalizeCursorMembers, normalizeCursorTopModels, normalizeCursorDailyUsage, type CursorUsageResponse, type CursorEventsResponse, type CursorMembersResponse } from "./cursor";
import { cursorUsageFixture } from "@/lib/ingest/fixtures/cursor-usage";
import { cursorEventsFixture } from "@/lib/ingest/fixtures/cursor-events";
import { cursorMembersFixture } from "@/lib/ingest/fixtures/cursor-members";
import { SchemaDriftError } from "@/lib/ingest/types";
import type { ResolvedFact } from "@/lib/ingest/persist";

describe("normalizeCursor", () => {
  it("emits one monthly $40 seat fact per distinct user, keyed by email", () => {
    const facts = normalizeCursor(cursorUsageFixture);
    // gareth (deduped across two days), tom, contractor = 3
    expect(facts).toHaveLength(3);
    const gareth = facts.find((f) => f.entityKey === "gareth.jones@intenthq.com")!;
    expect(gareth).toMatchObject({
      source: "cursor",
      day: "2026-06-01",
      costType: "seat",
      costUsd: 40,
    });
  });

  it("fails loudly on schema drift rather than writing garbage", () => {
    expect(() => normalizeCursor({} as CursorUsageResponse)).toThrow(SchemaDriftError);
  });
});

describe("normalizeCursorEvents", () => {
  it("aggregates chargeable events into per-(email,day,model) overage facts", () => {
    const facts = normalizeCursorEvents(cursorEventsFixture);
    // gareth sonnet 6/1 (250+150), gareth gpt5 6/2, tom opus 6/1, contractor 6/3, the service
    // account 6/2 — the "Included in Business" and "Free" events are dropped.
    expect(facts).toHaveLength(5);

    const garethSonnet = facts.find((f) => f.entityKey === "gareth.jones@intenthq.com" && f.model === "claude-sonnet-4-6")!;
    expect(garethSonnet).toMatchObject({
      source: "cursor",
      day: "2026-06-01",
      costType: "overage",
      costUsd: 4, // (250 + 150) / 100
      model: "claude-sonnet-4-6",
    });

    const tom = facts.find((f) => f.entityKey === "tom.reeve@intenthq.com")!;
    expect(tom).toMatchObject({ day: "2026-06-01", costType: "overage", costUsd: 10, model: "claude-opus-4-1" });
  });

  it("excludes plan-included usage even when Cursor prices it, so the seat fee is never paid twice", () => {
    const facts = normalizeCursorEvents(cursorEventsFixture);
    expect(facts.some((f) => f.model === "auto")).toBe(false);
    // The priced "Included in Business" event (356c) must not join gareth's on-demand 400c.
    expect(facts.find((f) => f.entityKey === "gareth.jones@intenthq.com" && f.model === "claude-sonnet-4-6")!.costUsd).toBe(4);
    expect(facts.some((f) => f.model === "composer-1")).toBe(false);
  });

  it("keeps service-account on-demand spend (no email) under the account, not dropped", () => {
    const sa = normalizeCursorEvents(cursorEventsFixture).filter((f) => f.entityKey.startsWith("cursor service account"));
    expect(sa).toEqual([
      { source: "cursor", day: "2026-06-02", costType: "overage", entityKey: "cursor service account sa_608abc", costUsd: 5, model: "claude-sonnet-4-6" },
    ]);
  });

  it("files on-demand spend with neither an email nor an account under an unknown service account", () => {
    const facts = normalizeCursorEvents({ usageEvents: [{ timestamp: Date.UTC(2026, 5, 4, 12).toString(), model: "gpt-5", kind: "Usage-based", isChargeable: true, chargedCents: 70, serviceAccountId: "null" }] });
    expect(facts).toEqual([{ source: "cursor", day: "2026-06-04", costType: "overage", entityKey: "cursor service account (unknown)", costUsd: 0.7, model: "gpt-5" }]);
  });

  it("fails loudly on a charged event of a kind it doesn't know, rather than guessing whether it's billed", () => {
    const odd = { usageEvents: [{ timestamp: Date.UTC(2026, 5, 4, 12).toString(), userEmail: "a@intenthq.com", model: "x", kind: "Something New", isChargeable: true, chargedCents: 5 }] };
    expect(() => normalizeCursorEvents(odd)).toThrow(SchemaDriftError);
    // Unknown kinds that cost nothing are harmless.
    expect(normalizeCursorEvents({ usageEvents: [{ ...odd.usageEvents[0], chargedCents: 0 }] })).toEqual([]);
  });

  it("recognises Cursor's enum-style kind names too", () => {
    const ev = (kind: string) => ({ timestamp: Date.UTC(2026, 5, 4, 12).toString(), userEmail: "a@intenthq.com", model: "x", kind, isChargeable: true, chargedCents: 100 });
    expect(normalizeCursorEvents({ usageEvents: [ev("USAGE_EVENT_KIND_USAGE_BASED")] })).toHaveLength(1);
    expect(normalizeCursorEvents({ usageEvents: [ev("USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS")] })).toHaveLength(0);
  });

  it("fails loudly on schema drift rather than writing garbage", () => {
    expect(() => normalizeCursorEvents({} as CursorEventsResponse)).toThrow(SchemaDriftError);
  });
});

describe("normalizeCursorMembers", () => {
  it("emits one $40 seat per non-removed member for the given month, keyed by lowercased email", () => {
    const facts = normalizeCursorMembers(cursorMembersFixture, "2026-06-01");
    // gareth + idle.seat; the removed member is skipped.
    expect(facts).toHaveLength(2);
    expect(facts).toContainEqual({ source: "cursor", day: "2026-06-01", costType: "seat", entityKey: "gareth.jones@intenthq.com", costUsd: 40 });
    // The idle seat (no usage) is exactly what daily-usage-data would miss.
    expect(facts.some((f) => f.entityKey === "idle.seat@intenthq.com")).toBe(true);
    expect(facts.some((f) => f.entityKey === "left@intenthq.com")).toBe(false);
  });

  it("accepts a bare array as well as { teamMembers }", () => {
    const facts = normalizeCursorMembers([{ email: "a@intenthq.com", isRemoved: false }], "2026-06-01");
    expect(facts).toHaveLength(1);
  });

  it("fails loudly on schema drift", () => {
    expect(() => normalizeCursorMembers({} as CursorMembersResponse, "2026-06-01")).toThrow(SchemaDriftError);
  });
});

describe("normalizeCursorTopModels", () => {
  it("emits one (day, user, top-model) row per user/day with a mostUsedModel", () => {
    const rows = normalizeCursorTopModels(cursorUsageFixture);
    // Only gareth's 6/1 row has mostUsedModel in the fixture.
    expect(rows).toEqual([
      { day: "2026-06-01", entityKey: "gareth.jones@intenthq.com", model: "claude-sonnet-4-6" },
    ]);
  });

  it("fails loudly on schema drift", () => {
    expect(() => normalizeCursorTopModels({} as CursorUsageResponse)).toThrow(SchemaDriftError);
  });
});

describe("priceCursorSeats", () => {
  const seat = (employeeId: string | null): ResolvedFact => ({
    source: "cursor",
    day: "2026-10-01",
    costType: "seat",
    entityKey: `${employeeId ?? "nobody"}@intenthq.com`,
    costUsd: 40,
    employeeId,
  });
  it("prices seats by the employee's tier and leaves the rest at $40", () => {
    const facts = [seat("e1"), seat("e2"), seat(null)];
    const out = priceCursorSeats(facts, new Map([["e1", "premium"], ["e2", "free"]]), { standard: 40, premium: 120, free: 0 });
    expect(out.map((f) => f.costUsd)).toEqual([120, 0, 40]);
  });
});

describe("normalizeCursorDailyUsage", () => {
  it("maps one row per (day, email) with every counter, zero when absent", () => {
    const rows = normalizeCursorDailyUsage(cursorUsageFixture);
    const ada = rows.find((r) => r.day === "2026-06-01" && r.entityKey === "gareth.jones@intenthq.com")!;
    expect(ada).toMatchObject({ isActive: true, usageBasedReqs: 42, agentRequests: 0, mostUsedModel: "claude-sonnet-4-6" });
  });
  it("accepts an epoch `date` when `day` is absent", () => {
    const rows = normalizeCursorDailyUsage({ data: [{ date: Date.UTC(2026, 5, 3), email: "x@intenthq.com", isActive: true }] });
    expect(rows[0].day).toBe("2026-06-03");
  });
  it("fails loudly on schema drift", () => {
    expect(() => normalizeCursorDailyUsage({} as CursorUsageResponse)).toThrow(SchemaDriftError);
  });
});
