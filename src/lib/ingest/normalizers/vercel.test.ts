import { describe, expect, it } from "vitest";
import { normalizeVercel, type FocusCharge } from "./vercel";
import { SchemaDriftError } from "@/lib/ingest/types";

const charge = (over: Partial<FocusCharge>): FocusCharge => ({
  BilledCost: 1.5,
  ChargeCategory: "Usage",
  ChargePeriodStart: "2026-07-01T00:00:00Z",
  ServiceName: "Function Invocations",
  Tags: { ProjectId: "prj_abc", ProjectName: "ai-costs" },
  ...over,
});

describe("normalizeVercel", () => {
  it("maps categories to cost types and aggregates per (day, costType, entity, service)", () => {
    const facts = normalizeVercel([
      charge({}),                                   // usage → metered
      charge({ BilledCost: 0.5 }),                  // same key → aggregated
      charge({ ChargeCategory: "Purchase", ServiceName: "Pro Plan", Tags: undefined, BilledCost: 20 }),
    ]);
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.model === "Function Invocations")).toMatchObject({
      source: "vercel", day: "2026-07-01", costType: "metered",
      entityKey: "ai-costs", costUsd: 2, employeeId: null,
    });
    expect(facts.find((f) => f.model === "Pro Plan")).toMatchObject({
      costType: "subscription", entityKey: "team", costUsd: 20,
    });
  });

  it("passes negative credits through and maps Tax to subscription", () => {
    const facts = normalizeVercel([
      charge({ ChargeCategory: "Credit", BilledCost: -5, ServiceName: "Promo Credit", Tags: undefined }),
      charge({ ChargeCategory: "Tax", BilledCost: 3.1, ServiceName: "VAT", Tags: undefined }),
    ]);
    expect(facts.find((f) => f.model === "Promo Credit")).toMatchObject({ costType: "metered", costUsd: -5 });
    expect(facts.find((f) => f.model === "VAT")).toMatchObject({ costType: "subscription", costUsd: 3.1 });
  });

  it("falls back to ProjectId then 'team' for the entity key", () => {
    const facts = normalizeVercel([charge({ Tags: { ProjectId: "prj_xyz" } })]);
    expect(facts[0].entityKey).toBe("prj_xyz");
  });

  it("throws SchemaDriftError on an unknown ChargeCategory", () => {
    expect(() => normalizeVercel([charge({ ChargeCategory: "Refund" })])).toThrow(SchemaDriftError);
  });

  it("throws SchemaDriftError when required fields are missing", () => {
    expect(() => normalizeVercel([charge({ BilledCost: undefined as unknown as number })])).toThrow(SchemaDriftError);
  });
});
