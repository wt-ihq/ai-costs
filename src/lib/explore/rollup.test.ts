import { describe, expect, it } from "vitest";
import { buildExploreData, type RawScope } from "./build";
import { allTimePeriod, parsePeriod } from "./period";
import { rollUpFacts, rollUpScope } from "./rollup";
import type { ShapeFact } from "./shape";
import type { CostType, Vendor } from "@/lib/types";

const NOW = new Date("2026-06-17T12:00:00Z");

/** Deterministic PRNG so the fixture is the same on every run. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * A fixture shaped like production: several models and keys per person per day (the rows a
 * roll-up collapses), plus every person-less kind the ranked lists tell apart by key or model.
 * Costs are multiples of $0.25, so sums are exact whatever order they are added in.
 */
function fixture(): ShapeFact[] {
  const rand = rng(42);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const usd = () => Math.floor(rand() * 400) / 4;
  const people = [
    { id: "e1", name: "Ada", dept: "Eng" as string | null },
    { id: "e2", name: "Bo", dept: "Eng" },
    { id: "e3", name: "Cy", dept: "Sales" },
    { id: "e4", name: "Di", dept: null },
  ];
  const out: ShapeFact[] = [];
  const add = (f: Partial<ShapeFact> & Pick<ShapeFact, "day" | "source" | "costType">) =>
    out.push({ costUsd: usd(), employeeId: null, department: null, fullName: null, entityKey: "", model: "", ...f });

  for (const month of ["2026-03", "2026-04", "2026-05", "2026-06"]) {
    for (const p of people) {
      add({ day: `${month}-01`, source: "cursor", costType: "seat", costUsd: 40, employeeId: p.id, fullName: p.name, department: p.dept, entityKey: `${p.id}@x` });
    }
    add({ day: `${month}-01`, source: "chatgpt_business" as Vendor, costType: "seat", entityKey: "unassigned seats chatgpt" });
    add({ day: `${month}-01`, source: "other", costType: "subscription", department: "Eng", entityKey: "figma", model: "Figma" });
    add({ day: `${month}-01`, source: "other", costType: "subscription", entityKey: "notion", model: "Notion" });
    add({ day: `${month}-01`, source: "openrouter", costType: "subscription", department: "Eng", entityKey: "openrouter platform fee", model: "Platform fee" });
    for (let d = 1; d <= 28; d++) {
      const day = `${month}-${String(d).padStart(2, "0")}`;
      if (day > "2026-06-16") continue;
      for (const p of people) {
        for (let i = 0; i < 3; i++) {
          add({ day, source: "cursor", costType: "overage", employeeId: p.id, fullName: p.name, department: p.dept, entityKey: `${p.id}@x`, model: pick(["gpt-5", "opus", "sonnet"]) });
          add({ day, source: "anthropic", costType: "metered", employeeId: p.id, fullName: p.name, department: p.dept, entityKey: pick(["k1", "k2"]), model: pick(["opus", "haiku"]) });
          add({ day, source: "openrouter", costType: "metered", employeeId: p.id, fullName: p.name, department: p.dept, entityKey: `${p.id}@x`, model: pick(["a/b", "c/d"]) });
        }
      }
      for (const project of ["web", "docs"]) {
        for (const sku of ["Edge Requests", "Function Duration", "Bandwidth"]) {
          add({ day, source: "vercel", costType: "metered", department: project === "web" ? "Eng" : null, entityKey: project, model: sku });
        }
      }
      add({ day, source: "openrouter", costType: "metered", department: "Eng", entityKey: "Eng workspace", model: pick(["a/b", "c/d"]) });
      add({ day, source: "openrouter", costType: "metered", department: "Eng", entityKey: "Eng workspace", model: pick(["a/b", "c/d"]) });
      add({ day, source: "cursor", costType: "overage", department: "Eng", entityKey: "cursor service account sa_1", model: pick(["bugbot", "opus"]) });
      add({ day, source: "cursor", costType: "overage", entityKey: "cursor service account sa_2", model: "opus" });
      add({ day, source: "anthropic", costType: "metered", entityKey: "unkeyed", model: "" });
      add({ day, source: "openai", costType: "metered", entityKey: "org", model: pick(["gpt-5", "o3"]) });
      add({ day, source: "openai", costType: "metered", entityKey: "stranger@x", model: pick(["gpt-5", "o3"]) });
    }
  }
  return out;
}

const facts = fixture();
const base = { earliest: "2026-03", toolColors: { Figma: "#123456" }, horizons: { cursor: "2026-06-16", anthropic: "2026-06-16" }, lastUpdated: {} };
const company: RawScope = {
  ...base, kind: "company", title: "Company", facts,
  headcounts: { Eng: 2, Sales: 1, Unattributed: 1 },
  employees: [
    { id: "e1", fullName: "Ada", department: "Eng" }, { id: "e2", fullName: "Bo", department: "Eng" },
    { id: "e3", fullName: "Cy", department: "Sales" }, { id: "e4", fullName: "Di", department: null },
  ],
};
const team: RawScope = {
  ...base, kind: "team", title: "Eng", team: "Eng",
  facts: facts.filter((f) => f.department === "Eng"),
  employees: [{ id: "e1", fullName: "Ada" }, { id: "e2", fullName: "Bo" }],
};
const PERIODS = [
  parsePeriod("2026-06", NOW), parsePeriod("2026-05", NOW), parsePeriod("2026", NOW),
  parsePeriod("2026-06-10", NOW), allTimePeriod("2026-03", NOW),
];

/**
 * Deep equality, numbers to within a billionth of a dollar: summing the same amounts in another
 * order (which a roll-up does) can move a float's last digit where seats are spread over a month.
 */
function expectSame(actual: unknown, expected: unknown, path = "view"): void {
  if (typeof actual === "number" && typeof expected === "number") {
    if (Math.abs(actual - expected) > 1e-9) throw new Error(`${path}: ${actual} != ${expected}`);
    return;
  }
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") {
    if (actual !== expected) throw new Error(`${path}: ${String(actual)} != ${String(expected)}`);
    return;
  }
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  expect(Object.keys(a).sort(), path).toEqual(Object.keys(e).sort());
  for (const k of Object.keys(e)) expectSame(a[k], e[k], `${path}.${k}`);
}

describe("rollUpFacts", () => {
  it("collapses a person's per-model, per-key rows into one row a day per source and cost type", () => {
    const rolled = rollUpFacts(facts);
    expect(rolled.length).toBeLessThan(facts.length / 2);
    const adaCursorDay = rolled.filter((f) => f.employeeId === "e1" && f.source === "cursor" && f.costType === "overage" && f.day === "2026-06-10");
    expect(adaCursorDay).toHaveLength(1);
    expect(adaCursorDay[0]).toMatchObject({ model: "", entityKey: "", fullName: "Ada", department: "Eng" });
  });

  it("keeps the total", () => {
    const total = (rows: ShapeFact[]) => rows.reduce((s, r) => s + r.costUsd, 0);
    expect(total(rollUpFacts(facts))).toBe(total(facts));
  });

  it("keeps what the ranked lists read: the tool of an 'other' cost, and a person-less row's key", () => {
    const rolled = rollUpFacts(facts);
    const has = (source: Vendor, costType: CostType, entityKey: string, model?: string) =>
      rolled.some((f) => f.source === source && f.costType === costType && f.entityKey === entityKey && (model === undefined || f.model === model));
    expect(has("other", "subscription", "figma", "Figma")).toBe(true);
    expect(has("openrouter", "subscription", "openrouter platform fee", "Platform fee")).toBe(true);
    expect(has("vercel", "metered", "web", "")).toBe(true);
    expect(has("openrouter", "metered", "Eng workspace", "")).toBe(true);
    expect(has("cursor", "overage", "cursor service account sa_1", "bugbot")).toBe(true);
    expect(has("anthropic", "metered", "unkeyed")).toBe(true);
    expect(has("chatgpt_business" as Vendor, "seat", "unassigned seats chatgpt")).toBe(true);
  });

  it("keeps the first day's order, so the scope still starts on its earliest day", () => {
    expect(rollUpFacts(facts)[0].day).toBe(facts[0].day);
  });
});

describe("rollUpScope", () => {
  for (const [name, scope] of [["company", company], ["team", team]] as const) {
    it(`gives the ${name} page exactly the same view for every period`, () => {
      const rolled = rollUpScope(scope);
      expect(rolled.facts.length).toBeLessThan(scope.facts.length);
      for (const period of PERIODS) {
        expectSame(buildExploreData(rolled, period, NOW), buildExploreData(scope, period, NOW), `${name} ${period.label}`);
      }
    });
  }

  it("leaves a person's page alone: its line items are per model and key", () => {
    const person: RawScope = { ...base, kind: "person", title: "Ada", facts: facts.filter((f) => f.employeeId === "e1") };
    expect(rollUpScope(person)).toBe(person);
  });
});
