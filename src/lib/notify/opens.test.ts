import { describe, expect, it } from "vitest";
import { memoryStore, type SendRow } from "./memory-store";
import { openRedirectPath } from "./opens";
import type { NotifyEmployee } from "./types";

const ID = "6f1c2a9e-1b2c-4d5e-8f90-123456789abc";
const emp: NotifyEmployee = {
  id: "0b6c7d8e-0000-4000-8000-000000000001", email: "a@x.com", fullName: "A", department: "R&D", oktaId: null, employeeNumber: null,
  managerRef: null, employmentStatus: "active", leaveDate: null,
};
const row = (over: Partial<SendRow> = {}): SendRow => ({
  id: ID, employeeId: emp.id, cadence: "weekly", periodKey: "2026-W41", mode: "live", status: "sent", attempts: 1,
  slackTs: "1", detail: null, updatedAt: "2026-10-12T09:30:00Z", openedAt: null, ...over,
});

describe("openRedirectPath", () => {
  it("records the first open of a send and redirects to the recipient's Explore page", async () => {
    let t = Date.parse("2026-10-12T10:00:00Z");
    const store = memoryStore({ employees: [emp], sends: [row()] }, () => t);
    expect(await openRedirectPath(store, ID)).toBe(`/explore/R%26D/${emp.id}`);
    expect(store.sends[0].openedAt).toBe("2026-10-12T10:00:00.000Z");
    t += 3_600_000;
    await openRedirectPath(store, ID);
    expect(store.sends[0].openedAt).toBe("2026-10-12T10:00:00.000Z"); // the first open is kept
  });

  it("an unknown or malformed id goes to Explore and records nothing", async () => {
    const store = memoryStore({ employees: [emp], sends: [row()] });
    expect(await openRedirectPath(store, "6f1c2a9e-1b2c-4d5e-8f90-000000000000")).toBe("/explore");
    expect(await openRedirectPath(store, "not-a-uuid")).toBe("/explore");
    expect(store.sends[0].openedAt).toBeNull();
  });
});
