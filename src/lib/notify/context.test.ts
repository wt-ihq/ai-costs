import { describe, expect, it } from "vitest";
import type { ShapeFact } from "@/lib/explore/shape";
import { digestFor, factsWindow, loadNotifyContext, teamDigestFor } from "./context";
import { memoryStore } from "./memory-store";
import { periodFor } from "./schedule";
import type { NotifyEmployee } from "./types";

const now = new Date("2026-09-30T07:00:00Z");
const emp = (id: string, over: Partial<NotifyEmployee> = {}): NotifyEmployee => ({
  id, email: `${id}@x.com`, fullName: id, department: "Eng", oktaId: `00u${id}`, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null, ...over,
});
const fact = (day: string, usd: number, employeeId: string): ShapeFact => ({
  day, source: "cursor", costType: "overage", costUsd: usd, employeeId, department: "Eng", fullName: null, entityKey: employeeId, model: "",
});

describe("factsWindow", () => {
  it("covers 7 months of history for projections/charts, through tomorrow", () => {
    expect(factsWindow(now)).toEqual({ from: "2026-02-01", toExclusive: "2026-10-01" });
    expect(factsWindow(now, "2025-12-01").from).toBe("2025-12-01");
    expect(factsWindow(now, "2026-06-01").from).toBe("2026-02-01");
  });
});

describe("loadNotifyContext / digestFor", () => {
  const store = memoryStore({
    employees: [emp("m"), emp("a", { managerRef: "00um" })],
    facts: [fact("2026-09-22", 10, "m"), fact("2026-09-23", 25, "a")],
  });

  it("reads facts once for the window and builds the tree", async () => {
    const ctx = await loadNotifyContext(store, now, "https://x.test");
    expect(store.factCalls).toEqual([["2026-02-01", "2026-10-01"]]);
    expect(ctx.tree.reportsOf("m")).toEqual(["a"]);
  });

  it("builds a manager digest from the tree, and null for unknown people", async () => {
    const ctx = await loadNotifyContext(store, now, "https://x.test");
    const d = digestFor(ctx, "m", periodFor("weekly", "2026-W39", now))!;
    expect(d.you.headlineUsd).toBe(10);
    expect(d.reports!.headlineUsd).toBe(25);
    expect(digestFor(ctx, "nobody", periodFor("weekly", "2026-W39", now))).toBeNull();
  });
});

describe("teamDigestFor", () => {
  const store = memoryStore({
    employees: [emp("m"), emp("a", { managerRef: "00um" }), emp("s", { department: "Data" })],
    facts: [fact("2026-09-22", 10, "m"), fact("2026-09-23", 25, "a"), { ...fact("2026-09-23", 99, "s"), department: "Data" }],
  });

  it("builds the department's digest from the shared context, with its Explore link", async () => {
    const ctx = await loadNotifyContext(store, now, "https://x.test");
    const d = teamDigestFor(ctx, "Eng", periodFor("weekly", "2026-W39", now))!;
    expect(d).toMatchObject({ kind: "team", department: "Eng", dashboardUrl: "https://x.test/explore/Eng" });
    expect(d.team).toMatchObject({ headlineUsd: 35, headcount: 2 });
  });

  it("is null for a daily with no usage", async () => {
    const ctx = await loadNotifyContext(store, now, "https://x.test");
    expect(teamDigestFor(ctx, "Eng", periodFor("daily", "2026-09-26", now))).toBeNull();
  });
});
