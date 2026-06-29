import { describe, expect, it } from "vitest";
import { buildTopModelData, type TopModelRow } from "./top-model-shape";
import { parsePeriod } from "@/lib/explore/period";

const june = parsePeriod("2026-06", new Date("2026-06-29T00:00:00Z"));

const rows: TopModelRow[] = [
  // Gareth: sonnet 3 days, gpt 1 day → primary = sonnet
  { day: "2026-06-01", model: "claude-sonnet-4.5", entityKey: "g@x.com", employeeId: "e1", fullName: "Gareth", department: "Eng" },
  { day: "2026-06-02", model: "claude-sonnet-4.5", entityKey: "g@x.com", employeeId: "e1", fullName: "Gareth", department: "Eng" },
  { day: "2026-06-03", model: "claude-sonnet-4.5", entityKey: "g@x.com", employeeId: "e1", fullName: "Gareth", department: "Eng" },
  { day: "2026-06-04", model: "gpt-4o", entityKey: "g@x.com", employeeId: "e1", fullName: "Gareth", department: "Eng" },
  // Tom: sonnet 1 day → primary = sonnet
  { day: "2026-06-01", model: "claude-sonnet-4.5", entityKey: "t@x.com", employeeId: "e2", fullName: "Tom", department: "Design" },
  // out of period
  { day: "2026-05-30", model: "gpt-4o", entityKey: "t@x.com", employeeId: "e2", fullName: "Tom", department: "Design" },
];

describe("buildTopModelData", () => {
  it("picks each person's primary (most-frequent) model and counts users per model", () => {
    const data = buildTopModelData({ rows, earliest: "2026-05" }, june);
    expect(data.activeUsers).toBe(2);
    // Both have sonnet primary → distribution: sonnet=2
    expect(data.distribution[0]).toMatchObject({ key: "claude-sonnet-4.5", value: 2 });
    const gareth = data.people.find((p) => p.id === "e1")!;
    expect(gareth).toMatchObject({ name: "Gareth", primaryModel: "claude-sonnet-4.5", days: 4 });
  });

  it("excludes out-of-period rows", () => {
    const data = buildTopModelData({ rows, earliest: "2026-05" }, june);
    const tom = data.people.find((p) => p.id === "e2")!;
    expect(tom.days).toBe(1); // the May row is excluded
  });
});
