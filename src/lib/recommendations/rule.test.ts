import { describe, expect, it } from "vitest";
import {
  latestSunday,
  patternWord,
  recommend,
  weeksEnding,
  type RecCandidate,
  type RecToolInput,
} from "./rule";

const cand = (employeeId: string, tier: RecCandidate["tier"], leaveDate: string | null = null): RecCandidate => ({
  employeeId,
  name: employeeId,
  department: null,
  tier,
  leaveDate,
});

const baseInput = (): RecToolInput => ({
  tool: "claude_team",
  stepUpUsd: 80,
  candidates: [cand("ada", "standard"), cand("bo", "premium"), cand("cy", "free")],
  spend: [
    { employeeId: "ada", day: "2026-10-14", costUsd: 100 },
    { employeeId: "bo", day: "2026-10-28", costUsd: 500 },
    { employeeId: "cy", day: "2026-10-28", costUsd: 300 },
    { employeeId: "dee", day: "2026-10-28", costUsd: 90 },
  ],
});

describe("recommendation rule", () => {
  it("latestSunday: a Tuesday → the Sunday before; a Sunday → itself", () => {
    expect(latestSunday(new Date("2026-11-03T09:00:00Z"))).toBe("2026-11-01");
    expect(latestSunday(new Date("2026-11-01T23:00:00Z"))).toBe("2026-11-01");
  });

  it("weeksEnding gives four Monday-to-Monday weeks, oldest first", () => {
    expect(weeksEnding("2026-11-01", 4)[0]).toEqual({ from: "2026-10-05", toExclusive: "2026-10-12" });
    expect(weeksEnding("2026-11-01", 4)[3]).toEqual({ from: "2026-10-26", toExclusive: "2026-11-02" });
  });

  it("patternWord", () => {
    expect(patternWord([{ extraUsd: 30 }, { extraUsd: 30 }, { extraUsd: 30 }, { extraUsd: 5 }], 80)).toBe("steady");
    expect(patternWord([{ extraUsd: 0 }, { extraUsd: 0 }, { extraUsd: 50 }, { extraUsd: 60 }], 80)).toBe("recent");
    expect(patternWord([{ extraUsd: 0 }, { extraUsd: 90 }, { extraUsd: 0 }, { extraUsd: 2 }], 80)).toBe("one-off");
    expect(patternWord([{ extraUsd: 50 }, { extraUsd: 0 }, { extraUsd: 0 }, { extraUsd: 50 }], 80)).toBe("on and off");
    expect(patternWord([{ extraUsd: 0 }, { extraUsd: 0 }, { extraUsd: 0 }, { extraUsd: 0 }], 80)).toBe("on and off");
  });

  it("flags Standard holders over the step up, never Premium or Free, and marks unknown tiers", () => {
    const r = recommend(baseInput(), "2026-11-01");
    expect(r.rows.map((x) => [x.employeeId, x.savingUsd, x.tierUnknown, x.pattern])).toEqual([
      ["ada", 20, false, "one-off"],
      ["dee", 10, true, "recent"],
    ]);
    expect(r.premiumCount).toBe(1);
    expect(r.totalSavingUsd).toBe(30);
  });

  it("newThisWeek is false when the previous window also flagged the person", () => {
    const input = baseInput();
    // ada also spent $100 earlier still, which sits in the previous window too
    input.spend.push({ employeeId: "ada", day: "2026-10-07", costUsd: 100 });
    const prevFlagged = recommend(input, "2026-11-01").rows.find((x) => x.employeeId === "ada");
    expect(prevFlagged?.newThisWeek).toBe(false);

    const fresh = recommend(baseInput(), "2026-11-01");
    // ada's $100 on 14 Oct is in the previous window as well (1 of 4 weeks, over 80) → not new
    expect(fresh.rows.find((x) => x.employeeId === "ada")?.newThisWeek).toBe(false);
    // dee has nothing before this window → new
    expect(fresh.rows.find((x) => x.employeeId === "dee")?.newThisWeek).toBe(true);
  });

  it("drops leavers and fills Cursor hover figures from usage", () => {
    const input: RecToolInput = {
      tool: "cursor",
      stepUpUsd: 80,
      candidates: [cand("ada", "standard"), cand("gone", "standard", "2026-10-15")],
      spend: [
        { employeeId: "ada", day: "2026-10-28", costUsd: 100 },
        { employeeId: "gone", day: "2026-10-28", costUsd: 100 },
      ],
      usage: [
        { employeeId: "ada", day: "2026-10-27", agentRequests: 10, isActive: true },
        { employeeId: "ada", day: "2026-10-28", agentRequests: 5, isActive: true },
        { employeeId: "ada", day: "2026-10-29", agentRequests: 0, isActive: false },
        { employeeId: "ada", day: "2026-10-05", agentRequests: 7, isActive: true },
      ],
    };
    const r = recommend(input, "2026-11-01");
    expect(r.rows.map((x) => x.employeeId)).toEqual(["ada"]);
    const weeks = r.rows[0].weeks;
    expect(weeks).toHaveLength(4);
    expect(weeks[3]).toMatchObject({ from: "2026-10-26", extraUsd: 100, requests: 15, activeDays: 2 });
    expect(weeks[0]).toMatchObject({ from: "2026-10-05", extraUsd: 0, requests: 7, activeDays: 1 });
    expect(weeks[1]).toMatchObject({ requests: 0, activeDays: 0 });

    const noUsage = recommend({ ...input, usage: undefined }, "2026-11-01");
    expect(noUsage.rows[0].weeks.every((w) => w.requests === null && w.activeDays === null)).toBe(true);
  });

  it("exact step up is not flagged, and spend outside the windows is ignored", () => {
    const input: RecToolInput = {
      tool: "chatgpt_business",
      stepUpUsd: 80,
      candidates: [cand("ada", "standard"), cand("bo", "standard")],
      spend: [
        { employeeId: "ada", day: "2026-10-28", costUsd: 80 },
        { employeeId: "bo", day: "2026-11-02", costUsd: 500 },
        { employeeId: "bo", day: "2026-09-01", costUsd: 500 },
      ],
    };
    expect(recommend(input, "2026-11-01").rows).toEqual([]);
  });
});
